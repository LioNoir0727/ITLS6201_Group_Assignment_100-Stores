(function () {
  "use strict";

  const dataPaths = {
    gccsa: "data/gccsa.geojson",
    metroBoundary: "data/metropolitan_sydney_boundary.geojson",
    sa3: "data/sa3.geojson",
    sa2: "data/sa2.geojson",
    density: "data/sa2_population_density.geojson",
    roads: "data/major_roads.geojson",
    stores: "data/generated_stores_100.geojson"
  };

  const fieldSets = {
    gccsaName: ["GCCSA_NAME21", "GCC_NAME21", "GCCSA_NAME", "name", "NAME"],
    gccsaCode: ["GCCSA_CODE21", "GCC_CODE21", "GCCSA_CODE", "GCC_CODE"],
    membership: ["GCCSA_NAME21", "GCC_NAME21", "GCCSA_NAME", "GCCSA_CODE21", "GCC_CODE21"],
    sa3Name: ["SA3_NAME21", "SA3_NAME", "NAME", "name"],
    sa3Code: ["SA3_CODE21", "SA3_CODE"],
    sa2Name: ["SA2_NAME21", "SA2_NAME", "NAME", "name"],
    sa2Code: ["SA2_CODE21", "SA2_CODE"],
    population: ["population_2021", "POPULATION_2021", "Population_2021", "population", "pop", "POP_2021", "2021"],
    areaSqKm: ["area_sqkm", "AREASQKM21", "AREA_SQKM", "AREASQKM", "area"],
    density: ["population_density", "density", "pop_density", "POP_DENSITY", "Population_density"],
    roadName: ["display_name", "name"],
    roadRef: ["ref"],
    roadClass: ["fclass"],
    roadGroup: ["road_group"]
  };

  const densityBreaks = [
    { min: 10000, color: "#ea580c" },
    { min: 6000, color: "#fb923c" },
    { min: 3000, color: "#fdba74" },
    { min: 1000, color: "#fed7aa" },
    { min: 0, color: "#fff7ed" }
  ];
  const CBD_LAT_LNG = [-33.8731, 151.2065];
  const KEY_FREIGHT_ROAD_TERMS = [
    "M1",
    "M2",
    "M4",
    "M5",
    "M7",
    "M8",
    "A3",
    "A6",
    "Great Western Highway",
    "Hume Motorway",
    "Southern Cross Drive",
    "Foreshore Road",
    "WestConnex"
  ];

  const map = L.map("map", {
    preferCanvas: true,
    zoomControl: true
  }).setView([-33.86, 151.05], 9);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(map);

  // Layer order from bottom to top: density, roads, SA2, SA3, Greater Sydney context, Metropolitan Sydney, stores.
  map.createPane("sa2DensityPane");
  map.getPane("sa2DensityPane").style.zIndex = 404;
  map.createPane("majorRoadsPane");
  map.getPane("majorRoadsPane").style.zIndex = 410;
  map.createPane("sa2Pane");
  map.getPane("sa2Pane").style.zIndex = 420;
  map.createPane("sa3Pane");
  map.getPane("sa3Pane").style.zIndex = 430;
  map.createPane("gccsaPane");
  map.getPane("gccsaPane").style.zIndex = 438;
  map.createPane("metroBoundaryPane");
  map.getPane("metroBoundaryPane").style.zIndex = 445;
  map.createPane("generatedStoresPane");
  map.getPane("generatedStoresPane").style.zIndex = 455;

  const renderers = {
    density: L.canvas({ padding: 0.5, pane: "sa2DensityPane" }),
    sa2: L.canvas({ padding: 0.5, pane: "sa2Pane" }),
    sa3: L.canvas({ padding: 0.5, pane: "sa3Pane" }),
    roads: L.canvas({ padding: 0.5, pane: "majorRoadsPane" })
  };

  const layers = {
    metroBoundary: L.layerGroup().addTo(map),
    gccsa: L.layerGroup().addTo(map),
    sa3: L.layerGroup().addTo(map),
    sa2: L.layerGroup(),
    density: L.layerGroup().addTo(map),
    roads: L.layerGroup().addTo(map),
    stores: L.layerGroup().addTo(map)
  };

  let greaterSydneyBounds = null;
  let metropolitanSydneyBounds = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setStatus(id, message, type) {
    const element = document.getElementById(id);
    element.textContent = message;
    element.classList.toggle("error", type === "error");
    element.classList.toggle("muted", type === "muted");
  }

  function setSummary(id, value) {
    document.getElementById(id).textContent = value;
  }

  function dataLoadError(path) {
    const fileNote = window.location.protocol === "file:"
      ? " If opened with file://, browser security may block local GeoJSON loading. Run a local server from codex_v3."
      : "";
    return `Error: ${path} could not be loaded.${fileNote}`;
  }

  async function fetchJson(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Could not load ${path}`);
    }
    return response.json();
  }

  function getGeoJsonFeatures(geoJson) {
    if (!geoJson || !geoJson.type) {
      throw new Error("Invalid GeoJSON object.");
    }

    const features = geoJson.type === "FeatureCollection" ? geoJson.features : [geoJson];
    return features.filter((feature) => feature && feature.type === "Feature" && feature.geometry);
  }

  function findField(properties, candidates) {
    if (!properties) {
      return "";
    }

    for (const candidate of candidates) {
      if (
        properties[candidate] !== undefined &&
        properties[candidate] !== null &&
        String(properties[candidate]).trim() !== ""
      ) {
        return candidate;
      }
    }

    const keys = Object.keys(properties);
    return keys.find((key) =>
      candidates.some((candidate) => candidate.toLowerCase() === key.toLowerCase()) &&
      String(properties[key]).trim() !== ""
    ) || "";
  }

  function getValue(feature, candidates) {
    const properties = feature.properties || {};
    const field = findField(properties, candidates);
    return field ? properties[field] : "";
  }

  function toNumber(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return null;
    }

    const numberValue = Number(String(value).replaceAll(",", ""));
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  function getNumber(feature, candidates) {
    return toNumber(getValue(feature, candidates));
  }

  function formatCount(value) {
    const numberValue = toNumber(value);
    return numberValue === null ? "Not available" : Math.round(numberValue).toLocaleString();
  }

  function formatArea(value) {
    const numberValue = toNumber(value);
    return numberValue === null
      ? "Not available"
      : `${numberValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} sq km`;
  }

  function formatDensity(value) {
    const numberValue = toNumber(value);
    return numberValue === null
      ? "Not available"
      : `${Math.round(numberValue).toLocaleString()} persons/sq km`;
  }

  function getDistanceZone(distanceKm) {
    const numericDistance = toNumber(distanceKm);

    if (numericDistance === null) {
      return {
        shortName: "Unknown",
        name: "Unknown distance zone",
        distanceLabel: "Not available",
        color: "#64748b"
      };
    }

    if (numericDistance <= 10) {
      return {
        shortName: "Inner",
        name: "Inner metro",
        distanceLabel: "0-10 km",
        color: "#2563eb"
      };
    }

    if (numericDistance <= 25) {
      return {
        shortName: "Middle",
        name: "Middle metro",
        distanceLabel: "10-25 km",
        color: "#10b981"
      };
    }

    return {
      shortName: "Outer",
      name: "Outer metro",
      distanceLabel: "25-45 km",
      color: "#8b5cf6"
    };
  }

  function getStoreRingStyle(ring) {
    const normalizedRing = String(ring || "").toLowerCase();

    if (normalizedRing === "inner") {
      return { color: "#2563eb", label: "Inner metro", distanceLabel: "0-10 km" };
    }

    if (normalizedRing === "middle") {
      return { color: "#10b981", label: "Middle metro", distanceLabel: "10-25 km" };
    }

    if (normalizedRing === "outer") {
      return { color: "#8b5cf6", label: "Outer metro", distanceLabel: "25-45 km" };
    }

    return { color: "#64748b", label: "Unknown ring", distanceLabel: "Not available" };
  }

  function isGreaterSydney(feature) {
    const name = String(getValue(feature, fieldSets.gccsaName)).toLowerCase();
    const code = String(getValue(feature, fieldSets.gccsaCode)).toLowerCase();
    return name.includes("greater sydney") || code.includes("1gsyd");
  }

  function isGreaterSydneyMember(feature) {
    const membership = String(getValue(feature, fieldSets.membership)).toLowerCase();
    return membership.includes("greater sydney") || membership.includes("1gsyd");
  }

  function filterToGreaterSydneyIfPossible(features) {
    const hasMembershipField = features.some((feature) =>
      findField(feature.properties || {}, fieldSets.membership)
    );

    if (!hasMembershipField) {
      return features;
    }

    const filteredFeatures = features.filter(isGreaterSydneyMember);
    return filteredFeatures.length > 0 ? filteredFeatures : features;
  }

  function syncLayer(toggleId, layerGroup) {
    const checked = document.getElementById(toggleId).checked;

    if (checked) {
      map.addLayer(layerGroup);
    } else {
      map.removeLayer(layerGroup);
    }
  }

  function getPopulationDensity(feature) {
    const density = getNumber(feature, fieldSets.density);
    if (density !== null) {
      return density;
    }

    const population = getNumber(feature, fieldSets.population);
    const area = getNumber(feature, fieldSets.areaSqKm);
    if (population !== null && area !== null && area > 0) {
      return population / area;
    }

    return null;
  }

  function getDensityColor(feature) {
    const density = getPopulationDensity(feature);
    if (density === null) {
      return "#e5e7eb";
    }

    return densityBreaks.find((step) => density >= step.min).color;
  }

  function styleSA2Density(feature) {
    const density = getPopulationDensity(feature);

    return {
      color: "transparent",
      weight: 0,
      opacity: 0,
      fillColor: getDensityColor(feature),
      fillOpacity: density === null ? 0.12 : 0.35,
      lineCap: "round",
      lineJoin: "round"
    };
  }

  function styleSA2DensityHover(feature) {
    return {
      ...styleSA2Density(feature),
      color: "#ffffff",
      weight: 0.5,
      opacity: 0.55,
      fillOpacity: 0.48
    };
  }

  function createSA2DensityPopup(feature) {
    const name = getValue(feature, fieldSets.sa2Name) || "SA2 area";
    const code = getValue(feature, fieldSets.sa2Code) || "Not available";
    const population = getNumber(feature, fieldSets.population);
    const area = getNumber(feature, fieldSets.areaSqKm);
    const density = getPopulationDensity(feature);

    return `
      <p class="popup-title">${escapeHtml(name)}</p>
      <table class="popup-table">
        <tr><td>SA2 code</td><td>${escapeHtml(code)}</td></tr>
        <tr><td>Population</td><td>${escapeHtml(formatCount(population))}</td></tr>
        <tr><td>Area</td><td>${escapeHtml(formatArea(area))}</td></tr>
        <tr><td>Density</td><td>${escapeHtml(formatDensity(density))}</td></tr>
      </table>
    `;
  }

  function styleSA2Boundary() {
    return {
      color: "#94a3b8",
      weight: 0.25,
      opacity: 0.25,
      fillColor: "#ffffff",
      fillOpacity: 0,
      lineCap: "round",
      lineJoin: "round"
    };
  }

  function styleSA3Boundary() {
    return {
      color: "#64748b",
      weight: 0.6,
      opacity: 0.35,
      fillColor: "#ffffff",
      fillOpacity: 0,
      lineCap: "round",
      lineJoin: "round"
    };
  }

  function styleGreaterSydneyBoundary() {
    return {
      color: "#94a3b8",
      weight: 1,
      opacity: 0.35,
      fillColor: "#ffffff",
      fillOpacity: 0,
      lineCap: "round",
      lineJoin: "round"
    };
  }

  function styleMetropolitanSydneyBoundary() {
    return {
      color: "#2563eb",
      weight: 3,
      opacity: 0.85,
      fillColor: "#2563eb",
      fillOpacity: 0.03,
      lineCap: "round",
      lineJoin: "round"
    };
  }

  function styleMajorRoad(feature) {
    return {
      color: "#475569",
      weight: 1.2,
      opacity: 0.35,
      lineCap: "round",
      lineJoin: "round"
    };
  }

  function styleMajorRoadHover(feature) {
    const baseStyle = styleMajorRoad(feature);
    return {
      ...baseStyle,
      weight: baseStyle.weight + 0.8,
      opacity: 0.85
    };
  }

  function createRoadPopup(feature) {
    const name = getValue(feature, fieldSets.roadName) || "Major road";
    const ref = getValue(feature, fieldSets.roadRef) || "Not available";
    const fclass = getValue(feature, fieldSets.roadClass) || "Not available";
    const roadGroup = getValue(feature, fieldSets.roadGroup) || "Not available";

    return `
      <p class="popup-title">${escapeHtml(name)}</p>
      <table class="popup-table">
        <tr><td>Road name</td><td>${escapeHtml(name)}</td></tr>
        <tr><td>Ref</td><td>${escapeHtml(ref)}</td></tr>
        <tr><td>Class</td><td>${escapeHtml(fclass)}</td></tr>
        <tr><td>Road group</td><td>${escapeHtml(roadGroup)}</td></tr>
      </table>
    `;
  }

  function isKeyFreightRoad(feature) {
    const properties = feature.properties || {};
    const candidateText = [
      properties.display_name,
      properties.ref,
      properties.name
    ].filter(Boolean).join(" ").toUpperCase();

    return KEY_FREIGHT_ROAD_TERMS.some((term) => {
      const upperTerm = term.toUpperCase();

      if (/^[AM]\d+$/.test(upperTerm)) {
        return new RegExp(`(^|[^A-Z0-9])${upperTerm}([^A-Z0-9]|$)`).test(candidateText);
      }

      return candidateText.includes(upperTerm);
    });
  }

  function createStorePopup(feature) {
    const properties = feature.properties || {};
    const ringStyle = getStoreRingStyle(properties.ring);

    return `
      <p class="popup-title">${escapeHtml(properties.store_id || "Generated store")}</p>
      <table class="popup-table">
        <tr><td>Store ring</td><td>${escapeHtml(ringStyle.label)} (${escapeHtml(ringStyle.distanceLabel)})</td></tr>
        <tr><td>SA2</td><td>${escapeHtml(properties.sa2_name || "Not available")}</td></tr>
        <tr><td>SA2 code</td><td>${escapeHtml(properties.sa2_code || "Not available")}</td></tr>
        <tr><td>Distance to CBD</td><td>${escapeHtml(toNumber(properties.distance_to_cbd_km)?.toFixed(2) || "Not available")} km</td></tr>
        <tr><td>Density class</td><td>${escapeHtml(properties.density_class || "Not available")}</td></tr>
        <tr><td>Population density</td><td>${escapeHtml(formatDensity(properties.population_density))}</td></tr>
        <tr><td>Store size</td><td>${escapeHtml(properties.store_size || "Not available")}</td></tr>
        <tr><td>Delivery frequency</td><td>${escapeHtml(properties.estimated_delivery_frequency || "Not available")}</td></tr>
      </table>
    `;
  }

  function createBoundaryPopup(feature, nameFields, codeFields, fallbackName, codeLabel) {
    const name = getValue(feature, nameFields) || fallbackName;
    const code = getValue(feature, codeFields) || "Not available";

    return `
      <p class="popup-title">${escapeHtml(name)}</p>
      <table class="popup-table">
        <tr><td>${escapeHtml(codeLabel)}</td><td>${escapeHtml(code)}</td></tr>
      </table>
    `;
  }

  function createMetropolitanBoundaryPopup() {
    return `
      <p class="popup-title">Metropolitan Sydney Analysis Area</p>
      <table class="popup-table">
        <tr><td>Use</td><td>Store generation boundary</td></tr>
        <tr><td>Ring centre</td><td>Sydney CBD / Town Hall</td></tr>
        <tr><td>Rings</td><td>Inner 0-10 km, Middle 10-25 km, Outer 25-45 km</td></tr>
      </table>
    `;
  }

  async function loadMetropolitanSydneyBoundary() {
    try {
      setStatus("metroBoundaryStatus", "Loading Metropolitan Sydney boundary...");
      const geoJson = await fetchJson(dataPaths.metroBoundary);
      const features = getGeoJsonFeatures(geoJson);

      layers.metroBoundary.clearLayers();
      const boundaryLayer = L.geoJSON({
        type: "FeatureCollection",
        features
      }, {
        pane: "metroBoundaryPane",
        style: styleMetropolitanSydneyBoundary
      }).addTo(layers.metroBoundary);

      boundaryLayer.bindPopup(createMetropolitanBoundaryPopup());
      metropolitanSydneyBounds = boundaryLayer.getBounds();

      if (metropolitanSydneyBounds.isValid()) {
        map.fitBounds(metropolitanSydneyBounds, { padding: [28, 28] });
      }

      syncLayer("metroBoundaryToggle", layers.metroBoundary);
      setStatus("metroBoundaryStatus", "Metropolitan Sydney analysis boundary loaded.");
      console.log(`Loaded Metropolitan Sydney boundary with ${features.length.toLocaleString()} feature(s).`);
    } catch (error) {
      console.error("Failed to load Metropolitan Sydney boundary:", error);
      setStatus("metroBoundaryStatus", dataLoadError(dataPaths.metroBoundary), "error");
    }
  }

  async function loadGreaterSydneyBoundary() {
    try {
      setStatus("boundaryStatus", "Loading Greater Sydney boundary...");
      const geoJson = await fetchJson(dataPaths.gccsa);
      const features = getGeoJsonFeatures(geoJson);
      const greaterSydneyFeature = features.find(isGreaterSydney) || features[0];

      if (!greaterSydneyFeature) {
        throw new Error("Greater Sydney boundary not found.");
      }

      layers.gccsa.clearLayers();
      const boundaryLayer = L.geoJSON(greaterSydneyFeature, {
        pane: "gccsaPane",
        style: styleGreaterSydneyBoundary
      }).addTo(layers.gccsa);

      boundaryLayer.bindPopup("Greater Sydney Metropolitan Area");
      greaterSydneyBounds = boundaryLayer.getBounds();

      syncLayer("greaterSydneyToggle", layers.gccsa);
      setStatus("boundaryStatus", "Greater Sydney boundary loaded.");
      console.log("Loaded Greater Sydney boundary.");
    } catch (error) {
      console.error("Failed to load Greater Sydney boundary:", error);
      setStatus("boundaryStatus", dataLoadError(dataPaths.gccsa), "error");
    }
  }

  async function loadSA3Boundaries() {
    try {
      setStatus("sa3Status", "Loading SA3 boundaries...");
      const geoJson = await fetchJson(dataPaths.sa3);
      const selectedFeatures = filterToGreaterSydneyIfPossible(getGeoJsonFeatures(geoJson));

      layers.sa3.clearLayers();
      L.geoJSON({
        type: "FeatureCollection",
        features: selectedFeatures
      }, {
        pane: "sa3Pane",
        renderer: renderers.sa3,
        style: styleSA3Boundary,
        onEachFeature: (feature, layer) => {
          layer.bindPopup(createBoundaryPopup(
            feature,
            fieldSets.sa3Name,
            fieldSets.sa3Code,
            "SA3 area",
            "SA3 code"
          ));
        }
      }).addTo(layers.sa3);

      setSummary("sa3FeatureCount", selectedFeatures.length.toLocaleString());
      syncLayer("sa3Toggle", layers.sa3);
      setStatus("sa3Status", `${selectedFeatures.length.toLocaleString()} SA3 boundaries loaded.`);
      console.log(`Loaded ${selectedFeatures.length} SA3 boundaries.`);
    } catch (error) {
      console.error("Failed to load SA3 boundaries:", error);
      setStatus("sa3Status", dataLoadError(dataPaths.sa3), "error");
    }
  }

  async function loadSA2Boundaries() {
    try {
      setStatus("sa2Status", "Loading SA2 boundaries...");
      const geoJson = await fetchJson(dataPaths.sa2);
      const selectedFeatures = filterToGreaterSydneyIfPossible(getGeoJsonFeatures(geoJson));

      layers.sa2.clearLayers();
      L.geoJSON({
        type: "FeatureCollection",
        features: selectedFeatures
      }, {
        pane: "sa2Pane",
        renderer: renderers.sa2,
        style: styleSA2Boundary,
        onEachFeature: (feature, layer) => {
          layer.bindPopup(createBoundaryPopup(
            feature,
            fieldSets.sa2Name,
            fieldSets.sa2Code,
            "SA2 area",
            "SA2 code"
          ));
        }
      }).addTo(layers.sa2);

      setSummary("sa2FeatureCount", selectedFeatures.length.toLocaleString());
      syncLayer("sa2Toggle", layers.sa2);
      setStatus("sa2Status", `${selectedFeatures.length.toLocaleString()} SA2 boundaries loaded. Layer is off by default.`, "muted");
      console.log(`Loaded ${selectedFeatures.length} SA2 boundaries.`);
    } catch (error) {
      console.error("Failed to load SA2 boundaries:", error);
      setStatus("sa2Status", dataLoadError(dataPaths.sa2), "error");
    }
  }

  async function loadSA2PopulationDensity() {
    try {
      setStatus("densityStatus", "Loading SA2 population density...");
      const geoJson = await fetchJson(dataPaths.density);
      const selectedFeatures = filterToGreaterSydneyIfPossible(getGeoJsonFeatures(geoJson));
      const validDensityCount = selectedFeatures.filter((feature) => getPopulationDensity(feature) !== null).length;

      layers.density.clearLayers();
      L.geoJSON({
        type: "FeatureCollection",
        features: selectedFeatures
      }, {
        pane: "sa2DensityPane",
        renderer: renderers.density,
        style: styleSA2Density,
        onEachFeature: (feature, layer) => {
          layer.bindPopup(createSA2DensityPopup(feature));
          layer.on({
            mouseover: () => {
              layer.setStyle(styleSA2DensityHover(feature));
              if (layer.bringToFront) {
                layer.bringToFront();
              }
            },
            mouseout: () => {
              layer.setStyle(styleSA2Density(feature));
            }
          });
        }
      }).addTo(layers.density);

      setSummary("densityLoadStatus", validDensityCount > 0 ? "Loaded" : "No density field");
      syncLayer("sa2DensityToggle", layers.density);
      setStatus(
        "densityStatus",
        `${selectedFeatures.length.toLocaleString()} SA2 population-density polygons loaded; ${validDensityCount.toLocaleString()} include density values.`
      );
      console.log(`Loaded ${selectedFeatures.length} SA2 population density features.`);
    } catch (error) {
      console.error("Failed to load SA2 population density:", error);
      setSummary("densityLoadStatus", "Failed");
      setStatus("densityStatus", dataLoadError(dataPaths.density), "error");
    }
  }

  async function loadMajorRoads() {
    try {
      setStatus("roadsStatus", "Loading major roads...");
      const geoJson = await fetchJson(dataPaths.roads);
      const features = getGeoJsonFeatures(geoJson).filter(isKeyFreightRoad);

      layers.roads.clearLayers();
      L.geoJSON({
        type: "FeatureCollection",
        features
      }, {
        pane: "majorRoadsPane",
        renderer: renderers.roads,
        style: styleMajorRoad,
        onEachFeature: (feature, layer) => {
          layer.bindPopup(createRoadPopup(feature));
          layer.on({
            mouseover: () => {
              layer.setStyle(styleMajorRoadHover(feature));
              if (layer.bringToFront) {
                layer.bringToFront();
              }
            },
            mouseout: () => {
              layer.setStyle(styleMajorRoad(feature));
            }
          });
        }
      }).addTo(layers.roads);

      setSummary("majorRoadFeatureCount", features.length.toLocaleString());
      syncLayer("majorRoadsToggle", layers.roads);
      setStatus("roadsStatus", `${features.length.toLocaleString()} key freight road features loaded.`);
      console.log(`Loaded ${features.length} key freight road features.`);
    } catch (error) {
      console.error("Failed to load major roads:", error);
      setStatus("roadsStatus", dataLoadError(dataPaths.roads), "error");
    }
  }

  async function loadGeneratedStores() {
    try {
      setStatus("storesStatus", "Loading generated stores...");
      const geoJson = await fetchJson(dataPaths.stores);
      const features = getGeoJsonFeatures(geoJson);

      layers.stores.clearLayers();
      L.geoJSON({
        type: "FeatureCollection",
        features
      }, {
        pointToLayer: (feature, latLng) => {
          const ringStyle = getStoreRingStyle(feature.properties?.ring);

          return L.circleMarker(latLng, {
            pane: "generatedStoresPane",
            radius: 5,
            color: "#ffffff",
            weight: 1.5,
            opacity: 1,
            fillColor: ringStyle.color,
            fillOpacity: 0.85,
            className: "store-marker-shadow"
          });
        },
        onEachFeature: (feature, layer) => {
          layer.bindPopup(createStorePopup(feature));
          layer.on({
            mouseover: () => {
              layer.setRadius(7);
              layer.setStyle({ weight: 2, fillOpacity: 1 });
              if (layer.bringToFront) {
                layer.bringToFront();
              }
            },
            mouseout: () => {
              const ringStyle = getStoreRingStyle(feature.properties?.ring);
              layer.setRadius(5);
              layer.setStyle({
                weight: 1.5,
                fillColor: ringStyle.color,
                fillOpacity: 0.85
              });
            }
          });
        }
      }).addTo(layers.stores);

      setSummary("generatedStoreCount", features.length.toLocaleString());
      syncLayer("generatedStoresToggle", layers.stores);
      setStatus("storesStatus", `${features.length.toLocaleString()} generated stores loaded.`);
      console.log(`Loaded ${features.length} generated store points.`);
    } catch (error) {
      console.error("Failed to load generated stores:", error);
      setStatus("storesStatus", dataLoadError(dataPaths.stores), "error");
    }
  }

  document.getElementById("metroBoundaryToggle").addEventListener("change", () => {
    syncLayer("metroBoundaryToggle", layers.metroBoundary);
  });

  document.getElementById("greaterSydneyToggle").addEventListener("change", () => {
    syncLayer("greaterSydneyToggle", layers.gccsa);
  });

  document.getElementById("sa3Toggle").addEventListener("change", () => {
    syncLayer("sa3Toggle", layers.sa3);
  });

  document.getElementById("sa2Toggle").addEventListener("change", () => {
    syncLayer("sa2Toggle", layers.sa2);
  });

  document.getElementById("sa2DensityToggle").addEventListener("change", () => {
    syncLayer("sa2DensityToggle", layers.density);
  });

  document.getElementById("majorRoadsToggle").addEventListener("change", () => {
    syncLayer("majorRoadsToggle", layers.roads);
  });

  document.getElementById("generatedStoresToggle").addEventListener("change", () => {
    syncLayer("generatedStoresToggle", layers.stores);
  });

  loadMetropolitanSydneyBoundary();
  loadGreaterSydneyBoundary();
  loadSA2PopulationDensity();
  loadSA2Boundaries();
  loadSA3Boundaries();
  loadMajorRoads();
  loadGeneratedStores();
}());
