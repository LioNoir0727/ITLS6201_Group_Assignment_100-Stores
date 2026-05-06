#!/usr/bin/env python3
"""
Generate 100 representative grocery store points for the codex_v3 map.

This version uses Metropolitan Sydney, not the full Greater Sydney GCCSA, as
the analysis boundary. The Metropolitan Sydney boundary is created from a
selected LGA set and saved as data/metropolitan_sydney_boundary.geojson.
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point
from shapely.ops import unary_union


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SA2_DENSITY_PATH = DATA_DIR / "sa2_population_density.geojson"
LGA_PATH = DATA_DIR / "lga.geojson"
METRO_BOUNDARY_PATH = DATA_DIR / "metropolitan_sydney_boundary.geojson"
OUTPUT_PATH = DATA_DIR / "generated_stores_100.geojson"
VALIDATION_PATH = DATA_DIR / "store_generation_validation.json"

CBD_LAT = -33.8731
CBD_LON = 151.2065
PROJECTED_CRS = "EPSG:7856"  # GDA2020 / MGA zone 56, suitable for Sydney distances.
RANDOM_SEED = 6201

METROPOLITAN_SYDNEY_LGAS = [
    "Bayside",
    "Blacktown",
    "Burwood",
    "Camden",
    "Campbelltown",
    "Canada Bay",
    "Canterbury-Bankstown",
    "Cumberland",
    "Fairfield",
    "Georges River",
    "Hornsby",
    "Hunters Hill",
    "Inner West",
    "Ku-ring-gai",
    "Lane Cove",
    "Liverpool",
    "Mosman",
    "North Sydney",
    "Northern Beaches",
    "Parramatta",
    "Penrith",
    "Randwick",
    "Ryde",
    "Strathfield",
    "Sutherland Shire",
    "Sydney",
    "The Hills Shire",
    "Waverley",
    "Willoughby",
    "Woollahra",
]

RING_RULES = {
    "Inner": {"min_km": 0, "max_km": 10, "spacing_km": 1.2},
    "Middle": {"min_km": 10, "max_km": 25, "spacing_km": 2.5},
    "Outer": {"min_km": 25, "max_km": 45, "spacing_km": 4.0},
}

RING_ALLOCATION = {
    "Inner": 25,
    "Middle": 40,
    "Outer": 35,
}


def require_file(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"Required file is missing: {path}")


def normalize_lga_name(value: object) -> str:
    return (
        str(value or "")
        .replace("‐", "-")
        .replace("‑", "-")
        .replace("‒", "-")
        .replace("–", "-")
        .replace("—", "-")
        .replace("(NSW)", " ")
        .replace("(Nsw)", " ")
        .lower()
        .replace("city council", " ")
        .replace("shire council", " ")
        .replace("municipal council", " ")
        .replace("municipality", " ")
        .replace("council", " ")
        .replace("shire", " ")
        .replace("city of", " ")
        .strip()
    )


def compact_name(value: str) -> str:
    return " ".join("".join(ch if ch.isalnum() or ch == "-" else " " for ch in value).split())


def create_metropolitan_boundary() -> gpd.GeoDataFrame:
    require_file(LGA_PATH)
    lga = gpd.read_file(LGA_PATH)
    if lga.crs is None:
        lga = lga.set_crs("EPSG:4326")

    lga_name_field = next((field for field in ["LGA_NAME25", "LGA_NAME24", "LGA_NAME21", "LGA_NAME", "name"] if field in lga.columns), None)
    if not lga_name_field:
        raise RuntimeError("No LGA name field found in lga.geojson.")

    target_names = {compact_name(normalize_lga_name(name)) for name in METROPOLITAN_SYDNEY_LGAS}
    selected = lga[lga[lga_name_field].apply(lambda value: compact_name(normalize_lga_name(value)) in target_names)].copy()

    if len(selected) != len(METROPOLITAN_SYDNEY_LGAS):
        found = set(selected[lga_name_field].apply(lambda value: compact_name(normalize_lga_name(value))))
        missing = sorted(target_names - found)
        raise RuntimeError(f"Expected {len(METROPOLITAN_SYDNEY_LGAS)} metropolitan LGAs, found {len(selected)}. Missing: {missing}")

    dissolved = gpd.GeoDataFrame(
        [{
            "name": "Metropolitan Sydney Analysis Area",
            "source": "Dissolved selected LGA boundaries",
            "lga_count": len(selected),
        }],
        geometry=[unary_union(selected.geometry)],
        crs=lga.crs,
    ).to_crs("EPSG:4326")
    dissolved.to_file(METRO_BOUNDARY_PATH, driver="GeoJSON")
    print("Metropolitan Sydney boundary saved to:", METRO_BOUNDARY_PATH)
    return dissolved


def classify_ring(distance_km: float) -> str | None:
    for ring, rule in RING_RULES.items():
        if rule["min_km"] <= distance_km < rule["max_km"]:
            return ring

    if distance_km >= RING_RULES["Outer"]["max_km"]:
        return "Outer"

    if math.isclose(distance_km, RING_RULES["Outer"]["max_km"]):
        return "Outer"

    return None


def classify_density_by_ring(sa2_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    sa2_gdf = sa2_gdf.copy()
    sa2_gdf["density_class"] = None

    for ring in RING_RULES:
        ring_mask = sa2_gdf["ring"].eq(ring)
        ring_densities = sa2_gdf.loc[ring_mask, "population_density"]

        if ring_densities.empty:
            continue

        low_cutoff = ring_densities.quantile(0.30)
        high_cutoff = ring_densities.quantile(0.70)

        sa2_gdf.loc[ring_mask & sa2_gdf["population_density"].le(low_cutoff), "density_class"] = "low"
        sa2_gdf.loc[ring_mask & sa2_gdf["population_density"].ge(high_cutoff), "density_class"] = "high"
        sa2_gdf.loc[ring_mask & sa2_gdf["density_class"].isna(), "density_class"] = "medium"

    return sa2_gdf


def store_limit(row: pd.Series, very_high_density_cutoff: float) -> int:
    if row["ring"] == "Outer" and row["density_class"] == "low":
        return 1

    if row["population_density"] >= very_high_density_cutoff:
        return 3

    return 2


def weighted_choice(candidates: gpd.GeoDataFrame, rng: random.Random) -> int:
    weights = (candidates["population_density"].clip(lower=1) * candidates["priority_multiplier"]).to_list()
    candidate_indices = list(candidates.index)
    return rng.choices(candidate_indices, weights=weights, k=1)[0]


def weighted_candidate_order(candidates: gpd.GeoDataFrame, rng: random.Random) -> list[int]:
    remaining = candidates.copy()
    ordered_indices: list[int] = []

    while not remaining.empty:
        selected_index = weighted_choice(remaining, rng)
        ordered_indices.append(selected_index)
        remaining = remaining.drop(index=selected_index)

    return ordered_indices


def random_point_in_polygon(geometry, rng: random.Random, max_attempts: int = 35) -> Point | None:
    minx, miny, maxx, maxy = geometry.bounds

    for _ in range(max_attempts):
        point = Point(rng.uniform(minx, maxx), rng.uniform(miny, maxy))
        if geometry.contains(point):
            return point

    fallback = geometry.representative_point()
    return fallback if geometry.contains(fallback) else None


def spacing_is_valid(point: Point, ring: str, placed_points: list[dict]) -> bool:
    minimum_distance_m = RING_RULES[ring]["spacing_km"] * 1000
    return all(point.distance(existing["geometry_projected"]) >= minimum_distance_m for existing in placed_points)


def find_valid_store_location(
    candidates: gpd.GeoDataFrame,
    ring: str,
    rng: random.Random,
    placed_points: list[dict],
) -> tuple[int, Point] | tuple[None, None]:
    core_candidates = candidates[candidates["within_outer_core"].eq(True)]
    search_sets = [core_candidates] if not core_candidates.empty else []
    search_sets.append(candidates)

    for candidate_set in search_sets:
        if candidate_set.empty:
            continue

        for selected_index in weighted_candidate_order(candidate_set, rng):
            selected_sa2 = candidate_set.loc[selected_index]

            for _ in range(12):
                candidate_point = random_point_in_polygon(selected_sa2.geometry, rng)

                if candidate_point is not None and spacing_is_valid(candidate_point, ring, placed_points):
                    return selected_index, candidate_point

    return None, None


def infer_store_attributes(ring: str, density_class: str) -> tuple[str, str]:
    if density_class == "high":
        return "Large supermarket", "Daily"

    if density_class == "medium":
        return "Standard supermarket", "4-5 deliveries per week"

    if ring == "Outer":
        return "Small neighbourhood store", "2-3 deliveries per week"

    return "Neighbourhood supermarket", "3-4 deliveries per week"


def prepare_sa2_data() -> tuple[gpd.GeoDataFrame, object]:
    require_file(SA2_DENSITY_PATH)
    metro_boundary = create_metropolitan_boundary()

    sa2 = gpd.read_file(SA2_DENSITY_PATH)
    if sa2.crs is None:
        sa2 = sa2.set_crs("EPSG:4326")

    sa2_projected = sa2.to_crs(PROJECTED_CRS)
    metro_projected = metro_boundary.to_crs(PROJECTED_CRS)
    metro_geometry = unary_union(metro_projected.geometry)
    cbd_projected = gpd.GeoSeries([Point(CBD_LON, CBD_LAT)], crs="EPSG:4326").to_crs(PROJECTED_CRS).iloc[0]

    sa2_projected["centroid_projected"] = sa2_projected.geometry.centroid
    sa2_projected["distance_to_cbd_km"] = sa2_projected["centroid_projected"].distance(cbd_projected) / 1000
    sa2_projected["centroid_inside_metro"] = sa2_projected["centroid_projected"].within(metro_geometry)
    sa2_projected["ring"] = sa2_projected["distance_to_cbd_km"].apply(classify_ring)
    sa2_projected["within_outer_core"] = sa2_projected["distance_to_cbd_km"].le(RING_RULES["Outer"]["max_km"])
    sa2_projected["priority_multiplier"] = sa2_projected["within_outer_core"].map({True: 1.0, False: 0.05})

    eligible = sa2_projected[
        sa2_projected["centroid_inside_metro"]
        & sa2_projected["population_density"].notna()
        & sa2_projected["population_density"].gt(50)
        & sa2_projected["ring"].notna()
    ].copy()
    eligible["geometry"] = eligible.geometry.intersection(metro_geometry)
    eligible = eligible[~eligible.geometry.is_empty & eligible.geometry.notna()].copy()

    eligible = classify_density_by_ring(eligible)
    very_high_density_cutoff = eligible["population_density"].quantile(0.90)
    eligible["store_limit"] = eligible.apply(store_limit, axis=1, very_high_density_cutoff=very_high_density_cutoff)
    eligible["current_store_count"] = 0

    print("SA2 population density features loaded:", len(sa2))
    print("SA2 features with centroids inside Metropolitan Sydney:", int(sa2_projected["centroid_inside_metro"].sum()))
    print("SA2 features after eligibility filters:", len(eligible))
    print("Very high density cutoff for max 3 stores:", round(very_high_density_cutoff, 2))
    print("Eligible SA2s by ring and density class:")
    print(eligible.groupby(["ring", "density_class"]).size().to_string())

    return eligible, metro_geometry


def generate_stores(eligible: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    rng = random.Random(RANDOM_SEED)
    placed_points: list[dict] = []
    store_records: list[dict] = []
    store_id = 1

    for ring, target_count in RING_ALLOCATION.items():
        print(f"Generating {target_count} stores for {ring}...")

        generated_for_bucket = 0
        bucket_attempts = 0
        max_bucket_attempts = target_count * 90

        while generated_for_bucket < target_count and bucket_attempts < max_bucket_attempts:
            bucket_attempts += 1
            candidates = eligible[
                eligible["ring"].eq(ring)
                & eligible["current_store_count"].lt(eligible["store_limit"])
            ]

            if candidates.empty:
                raise RuntimeError(
                    f"No eligible SA2 capacity remains for {ring}. "
                    f"Generated {generated_for_bucket} of {target_count}."
                )

            selected_index, candidate_point = find_valid_store_location(
                candidates,
                ring,
                rng,
                placed_points,
            )

            if selected_index is None or candidate_point is None:
                continue

            selected_sa2 = eligible.loc[selected_index]
            density_class = selected_sa2["density_class"]
            store_size, delivery_frequency = infer_store_attributes(ring, density_class)
            store_records.append({
                "store_id": f"STORE_{store_id:03d}",
                "ring": ring,
                "sa2_code": str(selected_sa2.get("SA2_CODE21", "")),
                "sa2_name": str(selected_sa2.get("SA2_NAME21", "")),
                "population_density": round(float(selected_sa2["population_density"]), 2),
                "distance_to_cbd_km": round(float(selected_sa2["distance_to_cbd_km"]), 2),
                "density_class": density_class,
                "store_size": store_size,
                "estimated_delivery_frequency": delivery_frequency,
                "geometry": candidate_point,
            })
            placed_points.append({
                "ring": ring,
                "geometry_projected": candidate_point,
            })
            eligible.at[selected_index, "current_store_count"] += 1
            store_id += 1
            generated_for_bucket += 1

        if generated_for_bucket < target_count:
            raise RuntimeError(
                f"Could not satisfy spacing rules for {ring}. "
                f"Generated {generated_for_bucket} of {target_count}."
            )

    stores_projected = gpd.GeoDataFrame(store_records, geometry="geometry", crs=PROJECTED_CRS)
    return stores_projected


def write_validation(stores_projected: gpd.GeoDataFrame, eligible: gpd.GeoDataFrame, metro_geometry) -> dict:
    inside_metro_count = int(stores_projected.geometry.within(metro_geometry).sum())
    ring_counts = {ring: int(count) for ring, count in stores_projected.groupby("ring").size().items()}
    validation = {
        "total_generated_stores": int(len(stores_projected)),
        "stores_inside_metropolitan_sydney_boundary": inside_metro_count,
        "ring_counts": {
            "Inner": ring_counts.get("Inner", 0),
            "Middle": ring_counts.get("Middle", 0),
            "Outer": ring_counts.get("Outer", 0),
        },
        "eligible_sa2s_used": int(stores_projected["sa2_code"].nunique()),
        "warning": "" if inside_metro_count == len(stores_projected) else "Warning: at least one store is outside the Metropolitan Sydney boundary.",
    }

    with VALIDATION_PATH.open("w", encoding="utf-8") as f:
        json.dump(validation, f, indent=2)

    print("\nValidation summary:")
    print("Total generated stores:", validation["total_generated_stores"])
    print("Stores inside Metropolitan Sydney boundary:", validation["stores_inside_metropolitan_sydney_boundary"])
    print("Inner / Middle / Outer store counts:", validation["ring_counts"])
    print("Eligible SA2s used:", validation["eligible_sa2s_used"])
    print("Warning:", validation["warning"] or "None")
    print("Validation saved to:", VALIDATION_PATH)

    return validation


def main() -> None:
    eligible, metro_geometry = prepare_sa2_data()
    stores_projected = generate_stores(eligible)

    if len(stores_projected) != 100:
        raise RuntimeError(f"Expected 100 stores, generated {len(stores_projected)}.")

    stores_wgs84 = stores_projected.to_crs("EPSG:4326")
    stores_wgs84.to_file(OUTPUT_PATH, driver="GeoJSON")
    write_validation(stores_projected, eligible, metro_geometry)

    print("\nStores by ring and density class:")
    print(stores_wgs84.groupby(["ring", "density_class"]).size().to_string())
    print("Stores per SA2 max:", stores_wgs84.groupby("sa2_code").size().max())
    print("Output saved to:", OUTPUT_PATH)


if __name__ == "__main__":
    main()
