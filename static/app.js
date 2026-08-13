(() => {
  "use strict";

  let map;
  let routeLayers;
  let municipalityLayer;
  let neighborhoodsLayer;
  let heatLayer;
  let selectedNeighborhoodLayer;
  let selectedNeighborhoodHalo;
  let currentMapMode = "neighborhood";
  let activeGeometryRequest;
  let currentMapData;
  let printDetailsState = [];
  const geometryCache = new Map();
  const defaultCenter = [-23.5, -46.85];
  const streetTypes = new Set([
    "RUA", "AVENIDA", "ALAMEDA", "TRAVESSA", "ESTRADA", "PRACA",
    "LARGO", "VIELA", "RODOVIA", "CAMINHO", "CALCADA", "VIA",
    "PASSAGEM", "ESCADA", "ESCADAO",
  ]);
  const excludedHighways = new Set([
    "footway", "path", "steps", "cycleway", "bridleway", "corridor",
    "elevator", "platform", "construction", "proposed", "raceway",
  ]);

  function teamColor(team) {
    // Passo áureo: mantém cores consecutivas bem separadas e estáveis.
    const hue = Math.round(((team - 1) * 137.508) % 360);
    return `hsl(${hue}, 66%, 40%)`;
  }

  function initMap() {
    if (map || typeof L === "undefined") return;
    map = L.map("map", { zoomControl: true }).setView(defaultCenter, 10);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      maxZoom: 20,
    }).addTo(map);
    routeLayers = L.featureGroup().addTo(map);
  }

  function normalizeStreetName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function streetCore(value) {
    const parts = normalizeStreetName(value).split(" ").filter(Boolean);
    return streetTypes.has(parts[0]) ? parts.slice(1).join(" ") : parts.join(" ");
  }

  function bigrams(value) {
    const compact = value.replace(/ /g, "");
    if (compact.length < 2) return new Set([compact]);
    const result = new Set();
    for (let index = 0; index < compact.length - 1; index += 1) {
      result.add(compact.slice(index, index + 2));
    }
    return result;
  }

  function nameSimilarity(left, right) {
    if (left === right) return 1;
    const a = bigrams(left);
    const b = bigrams(right);
    let intersection = 0;
    a.forEach((item) => { if (b.has(item)) intersection += 1; });
    return (2 * intersection) / Math.max(1, a.size + b.size);
  }

  function simplifyPolygon(points, maximum = 90) {
    if (points.length <= maximum) return points;
    const step = points.length / maximum;
    return Array.from({ length: maximum }, (_item, index) => points[Math.floor(index * step)]);
  }

  function pointInPolygon(point, polygon) {
    const [latitude, longitude] = point;
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
      const [currentLat, currentLon] = polygon[current];
      const [previousLat, previousLon] = polygon[previous];
      const intersects = ((currentLat > latitude) !== (previousLat > latitude)) &&
        (longitude < ((previousLon - currentLon) * (latitude - currentLat)) /
          ((previousLat - currentLat) || Number.EPSILON) + currentLon);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function clipWayGeometry(geometry, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) {
      return [geometry.map((point) => [point.lat, point.lon])];
    }
    const result = [];
    let currentSegment = [];
    for (let index = 0; index < geometry.length - 1; index += 1) {
      const first = [geometry[index].lat, geometry[index].lon];
      const second = [geometry[index + 1].lat, geometry[index + 1].lon];
      if (pointInPolygon(first, polygon) || pointInPolygon(second, polygon)) {
        if (!currentSegment.length) currentSegment.push(first);
        currentSegment.push(second);
      } else if (currentSegment.length) {
        if (currentSegment.length >= 2) result.push(currentSegment);
        currentSegment = [];
      }
    }
    if (currentSegment.length >= 2) result.push(currentSegment);
    return result;
  }

  async function fetchStreetGeometries(data, signal) {
    const cacheKey = `${data.municipio}|${data.bairro}`;
    if (geometryCache.has(cacheKey)) return geometryCache.get(cacheKey);
    const response = await fetch(`/geometrias?bairro=${encodeURIComponent(data.bairro_id)}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const ways = (payload.ways || []).filter((element) =>
      Array.isArray(element.geometry) &&
      element.geometry.length >= 2 &&
      !excludedHighways.has(element.tags?.highway)
    );
    geometryCache.set(cacheKey, ways);
    return ways;
  }

  function buildStreetMatcher(streets) {
    const exact = new Map();
    const byCore = new Map();
    streets.forEach((street) => {
      exact.set(normalizeStreetName(street.nome), street);
      const core = streetCore(street.nome);
      if (!byCore.has(core)) byCore.set(core, []);
      byCore.get(core).push(street);
    });

    return (osmName) => {
      if (!osmName) return null;
      const normalized = normalizeStreetName(osmName);
      if (exact.has(normalized)) return { street: exact.get(normalized), match: "exact" };
      const core = streetCore(normalized);
      const sameCore = byCore.get(core);
      if (sameCore?.length === 1) return { street: sameCore[0], match: "core" };

      let best = null;
      let bestScore = 0;
      let secondScore = 0;
      for (const [candidateCore, candidates] of byCore) {
        if (candidates.length !== 1 || Math.abs(candidateCore.length - core.length) > 7) continue;
        const score = nameSimilarity(core, candidateCore);
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          best = candidates[0];
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
      return bestScore >= 0.82 && bestScore - secondScore >= 0.06
        ? { street: best, match: "similar" }
        : null;
    };
  }

  function roadWeight(highway) {
    if (["motorway", "trunk"].includes(highway)) return 4.2;
    if (highway === "primary") return 3.8;
    if (highway === "secondary") return 3.3;
    if (highway === "tertiary") return 2.9;
    if (["service", "living_street"].includes(highway)) return 1.6;
    return 2.3;
  }

  function updateCoverage(matchedNames, totalStreets, waysCount, approximateWays, failed = false) {
    const coverage = document.getElementById("mapCoverage");
    if (!coverage) return;
    if (failed) {
      coverage.dataset.state = "error";
      coverage.innerHTML = "Não foi possível consultar o traçado real. Nenhuma linha artificial foi desenhada.";
      return;
    }
    const missing = Math.max(0, totalStreets - matchedNames.size);
    const percentage = totalStreets ? Math.round((matchedNames.size / totalStreets) * 100) : 0;
    coverage.dataset.state = missing ? "warning" : "success";
    coverage.innerHTML = `<strong>${matchedNames.size} de ${totalStreets} ruas CNEFE encontradas (${percentage}%)</strong>` +
      `<span>${waysCount} segmentos reais exibidos · ${approximateWays} vias OSM sem correspondência não coloridas</span>`;

    document.querySelectorAll(".street-row").forEach((row) => {
      const name = normalizeStreetName(row.querySelector(".street-name")?.textContent);
      row.classList.toggle("street-unmatched", !matchedNames.has(name));
      const status = row.querySelector(".street-map-status");
      if (status) {
        status.hidden = matchedNames.has(name);
        status.textContent = "sem correspondência OSM";
      }
    });
  }

  function setPrintReady(ready) {
    const button = document.querySelector('[data-action="print"]');
    if (!button) return;
    button.disabled = !ready;
    button.textContent = ready ? "Imprimir" : "Preparando mapa…";
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  }

  function renderPrintableMap(data, segments = [], statusText = "") {
    const container = document.getElementById("printMapGraphic");
    const contour = Array.isArray(data.contorno) ? data.contorno : [];
    if (!container || contour.length < 3) return;
    container.replaceChildren();

    const width = 1200;
    const height = 700;
    const padding = 34;
    const latitudes = contour.map((point) => Number(point[0]));
    const longitudes = contour.map((point) => Number(point[1]));
    const minimumLat = Math.min(...latitudes);
    const maximumLat = Math.max(...latitudes);
    const minimumLon = Math.min(...longitudes);
    const maximumLon = Math.max(...longitudes);
    const middleLat = (minimumLat + maximumLat) / 2;
    const longitudeScale = Math.cos((middleLat * Math.PI) / 180);
    const geographicWidth = Math.max((maximumLon - minimumLon) * longitudeScale, 0.000001);
    const geographicHeight = Math.max(maximumLat - minimumLat, 0.000001);
    const scale = Math.min(
      (width - padding * 2) / geographicWidth,
      (height - padding * 2) / geographicHeight,
    );
    const drawingWidth = geographicWidth * scale;
    const drawingHeight = geographicHeight * scale;
    const offsetX = (width - drawingWidth) / 2;
    const offsetY = (height - drawingHeight) / 2;

    const project = ([lat, lon]) => [
      offsetX + (Number(lon) - minimumLon) * longitudeScale * scale,
      offsetY + (maximumLat - Number(lat)) * scale,
    ];
    const pathData = (geometry) => geometry
      .map((point, index) => {
        const [x, y] = project(point);
        return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
    const polygonPoints = contour
      .map((point) => project(point).map((value) => value.toFixed(2)).join(","))
      .join(" ");

    const svg = svgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": `Mapa de rotas de ${data.bairro}`,
    });
    svg.appendChild(svgElement("rect", {
      x: "1", y: "1", width: String(width - 2), height: String(height - 2),
      rx: "12", fill: "#edf0ec", stroke: "#c9ced7", "stroke-width": "2",
    }));

    const definitions = svgElement("defs");
    const clipPath = svgElement("clipPath", { id: "print-neighborhood-clip" });
    clipPath.appendChild(svgElement("polygon", { points: polygonPoints }));
    definitions.appendChild(clipPath);
    svg.appendChild(definitions);
    svg.appendChild(svgElement("polygon", {
      points: polygonPoints,
      fill: "#fffdf9",
      stroke: "none",
    }));

    const roads = svgElement("g", { "clip-path": "url(#print-neighborhood-clip)" });
    segments.forEach((segment) => {
      const dataPath = pathData(segment.geometry);
      roads.appendChild(svgElement("path", {
        d: dataPath,
        fill: "none",
        stroke: "#ffffff",
        "stroke-width": String(segment.weight + 3),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        opacity: "0.9",
      }));
      roads.appendChild(svgElement("path", {
        d: dataPath,
        fill: "none",
        stroke: teamColor(segment.team),
        "stroke-width": String(segment.weight),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "stroke-dasharray": segment.approximate ? "8 6" : "none",
        opacity: segment.approximate ? "0.62" : "0.95",
      }));
    });
    svg.appendChild(roads);

    const labelSegments = new Map();
    segments.forEach((segment) => {
      if (!segment.name) return;
      const current = labelSegments.get(segment.name);
      if (!current || segment.geometry.length > current.geometry.length) {
        labelSegments.set(segment.name, segment);
      }
    });
    const labels = svgElement("g", { "clip-path": "url(#print-neighborhood-clip)" });
    [...labelSegments.values()].forEach((segment, index) => {
      const identifier = `print-street-${index}`;
      definitions.appendChild(svgElement("path", {
        id: identifier,
        d: pathData(segment.geometry),
        fill: "none",
        stroke: "none",
      }));
      const text = svgElement("text", {
        fill: "#24364d",
        stroke: "#ffffff",
        "stroke-width": "3",
        "paint-order": "stroke",
        "font-family": "Arial, sans-serif",
        "font-size": "9",
        "font-weight": "700",
        "text-anchor": "middle",
      });
      const textPath = svgElement("textPath", {
        href: `#${identifier}`,
        startOffset: "50%",
      });
      textPath.textContent = segment.name;
      text.appendChild(textPath);
      labels.appendChild(text);
    });
    svg.appendChild(labels);
    svg.appendChild(svgElement("polygon", {
      points: polygonPoints,
      fill: "none",
      stroke: "#16233f",
      "stroke-width": "3",
      "stroke-dasharray": "10 8",
      "stroke-linejoin": "round",
    }));

    if (!segments.length && statusText) {
      const message = svgElement("text", {
        x: String(width / 2),
        y: String(height / 2),
        "text-anchor": "middle",
        fill: "#697386",
        "font-family": "Arial, sans-serif",
        "font-size": "20",
      });
      message.textContent = statusText;
      svg.appendChild(message);
    }
    container.appendChild(svg);
  }

  function clearMap() {
    initMap();
    if (routeLayers) routeLayers.clearLayers();
    if (map && routeLayers && !map.hasLayer(routeLayers)) routeLayers.addTo(map);
    if (map && municipalityLayer) {
      map.removeLayer(municipalityLayer);
      municipalityLayer = null;
    }
    if (map && neighborhoodsLayer) {
      if (map.hasLayer(neighborhoodsLayer)) map.removeLayer(neighborhoodsLayer);
      neighborhoodsLayer = null;
    }
    if (map && heatLayer) map.removeLayer(heatLayer);
    heatLayer = null;
    if (map && selectedNeighborhoodLayer) map.removeLayer(selectedNeighborhoodLayer);
    if (map && selectedNeighborhoodHalo) map.removeLayer(selectedNeighborhoodHalo);
    selectedNeighborhoodLayer = null;
    selectedNeighborhoodHalo = null;
    currentMapMode = "neighborhood";
  }

  function drawSelectedNeighborhood(data) {
    if (selectedNeighborhoodHalo) map.removeLayer(selectedNeighborhoodHalo);
    if (selectedNeighborhoodLayer) map.removeLayer(selectedNeighborhoodLayer);
    selectedNeighborhoodHalo = null;
    const contour = data.contorno;
    if (!Array.isArray(contour) || contour.length < 3) return;
    selectedNeighborhoodLayer = L.polygon(contour, {
      color: "#16233f",
      weight: 2.5,
      opacity: 1,
      dashArray: "6 4",
      fill: true,
      fillColor: "#16233f",
      fillOpacity: 0.04,
    })
      .bindTooltip(`Bairro selecionado: ${escapeHtml(data.bairro)}`)
      .addTo(map);
  }

  function setMapMode(mode, animate = true) {
    if (!map) return;
    currentMapMode = mode;
    const municipalityMode = mode === "municipality";
    const heatMode = mode === "heat";
    if (municipalityMode) {
      if (map.hasLayer(routeLayers)) map.removeLayer(routeLayers);
      if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
      if (neighborhoodsLayer && !map.hasLayer(neighborhoodsLayer)) neighborhoodsLayer.addTo(map);
      const bounds = municipalityLayer?.getBounds();
      if (bounds?.isValid()) map.fitBounds(bounds, { padding: [34, 34], animate });
    } else {
      if (neighborhoodsLayer && map.hasLayer(neighborhoodsLayer)) map.removeLayer(neighborhoodsLayer);
      if (heatMode) {
        if (map.hasLayer(routeLayers)) map.removeLayer(routeLayers);
        if (heatLayer && !map.hasLayer(heatLayer)) heatLayer.addTo(map);
      } else {
        if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
        if (!map.hasLayer(routeLayers)) routeLayers.addTo(map);
      }
      const bounds = selectedNeighborhoodLayer?.getBounds();
      if (bounds?.isValid()) map.fitBounds(bounds, { padding: [42, 42], maxZoom: 16, animate });
    }
    municipalityLayer?.bringToFront();
    selectedNeighborhoodHalo?.bringToFront();
    selectedNeighborhoodLayer?.bringToFront();
    document.querySelectorAll(".map-view-actions button").forEach((button) => {
      const active = button.dataset.action === `fit-${mode}`;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function setMapControlsReady(ready) {
    document.querySelectorAll(".map-view-actions button").forEach((button) => {
      button.disabled = !ready;
      button.title = ready ? "" : "Aguarde a geração da divisão";
    });
  }

  async function renderMap() {
    initMap();
    const element = document.getElementById("mapData");
    if (!map || !element) return;
    clearMap();

    let data;
    try {
      data = JSON.parse(element.textContent);
    } catch (_error) {
      showMessage("Não foi possível interpretar os dados do mapa.");
      return;
    }
    currentMapData = data;
    setMapControlsReady(true);
    const printNeighborhood = document.getElementById("printBairro");
    const printCity = document.getElementById("printMunicipio");
    const printSummary = document.getElementById("printMapSummary");
    if (printNeighborhood) printNeighborhood.textContent = data.bairro;
    if (printCity) printCity.textContent = data.municipio;
    if (printSummary) {
      printSummary.textContent = `${data.ruas.length} ruas · ${totalTeamsFrom(data.ruas)} equipes · CNEFE 2022 / OpenStreetMap`;
    }

    activeGeometryRequest?.abort();
    activeGeometryRequest = new AbortController();
    setPrintReady(false);
    renderPrintableMap(data, [], "Carregando o traçado das ruas…");
    if (data.limite_municipio) {
      municipalityLayer = L.geoJSON(
        { type: "Feature", properties: {}, geometry: data.limite_municipio },
        {
          style: {
            color: "#e24d3b",
            weight: 4.2,
            opacity: 0.95,
            dashArray: "10 7",
            lineCap: "round",
            lineJoin: "round",
            fill: false,
          },
          interactive: true,
        },
      )
        .bindTooltip(`Limite municipal de ${escapeHtml(data.municipio)} · IBGE`)
        .addTo(map);
    }
    neighborhoodsLayer = L.featureGroup();
    (data.bairros_municipio || []).forEach((neighborhood) => {
      if (!Array.isArray(neighborhood.contorno) || neighborhood.contorno.length < 3) return;
      if (neighborhood.selecionado) {
        return;
      }
      const layer = L.polygon(neighborhood.contorno, {
        color: "#3b82a0",
        weight: 1.4,
        opacity: 0.78,
        dashArray: "5 5",
        fillColor: "#7ab6c8",
        fillOpacity: 0.025,
      });
      layer.bindTooltip(`Bairro estimado: ${escapeHtml(neighborhood.nome)}`);
      layer.addTo(neighborhoodsLayer);
    });
    const maximumHomes = Math.max(1, ...data.ruas.map((street) => Number(street.domicilios) || 0));
    const heatRenderer = L.canvas({ padding: 0.5 });
    heatLayer = L.layerGroup(data.ruas.map((street) => {
      const intensity = Math.sqrt((Number(street.domicilios) || 0) / maximumHomes);
      const hue = Math.round(220 - intensity * 220);
      return L.circleMarker([street.lat, street.lon], {
        renderer: heatRenderer,
        radius: 10 + intensity * 24,
        stroke: false,
        fillColor: `hsl(${hue}, 88%, 48%)`,
        fillOpacity: 0.24 + intensity * 0.28,
      }).bindTooltip(`<strong>${escapeHtml(street.nome)}</strong><br>${street.domicilios} domicílios`);
    }));
    drawSelectedNeighborhood(data);
    setMapMode("neighborhood", false);
    setTimeout(() => map.invalidateSize(), 50);
    applyTeamColors();

    const coverage = document.getElementById("mapCoverage");
    if (coverage) {
      coverage.dataset.state = "loading";
      coverage.textContent = "Consultando o traçado real das ruas no OpenStreetMap…";
    }
    try {
      const ways = await fetchStreetGeometries(data, activeGeometryRequest.signal);
      const matchStreet = buildStreetMatcher(data.ruas);
      const matchedNames = new Set();
      const printSegments = [];
      const geometriesByTeam = new Map();
      let approximateWays = 0;
      let renderedSegments = 0;

      ways.forEach((way) => {
        const clippedGeometries = clipWayGeometry(way.geometry, data.contorno);
        if (!clippedGeometries.length) return;
        const match = matchStreet(way.tags?.name);
        if (!match) {
          approximateWays += 1;
          return;
        }
        const team = match.street.equipe;
        const approximate = false;
        matchedNames.add(normalizeStreetName(match.street.nome));
        const weight = roadWeight(way.tags?.highway);
        const roadName = way.tags?.name || "Via sem nome no OpenStreetMap";
        const matchNote = `Correspondência ${match.match === "exact" ? "exata" : "por nome semelhante"} com o CNEFE`;
        clippedGeometries.forEach((geometry) => {
          renderedSegments += 1;
          printSegments.push({ geometry, team, approximate, weight, name: match.street.nome });
          if (!geometriesByTeam.has(team)) geometriesByTeam.set(team, []);
          geometriesByTeam.get(team).push(geometry);
        });
      });

      geometriesByTeam.forEach((geometries, team) => {
        L.polyline(geometries, {
          color: teamColor(team),
          weight: 2.6,
          opacity: 0.84,
          lineCap: "round",
          lineJoin: "round",
        })
          .bindTooltip(`Equipe ${team} · ${geometries.length} trechos`)
          .addTo(routeLayers);
      });

      // Recria por último para o limite permanecer acima de todas as ruas.
      drawSelectedNeighborhood(data);

      renderPrintableMap(data, printSegments);
      setPrintReady(true);
      updateCoverage(matchedNames, data.ruas.length, renderedSegments, approximateWays);
      municipalityLayer?.bringToFront();
      selectedNeighborhoodHalo?.bringToFront();
      selectedNeighborhoodLayer?.bringToFront();
    } catch (error) {
      if (error.name !== "AbortError") {
        console.warn("Falha ao consultar o traçado real:", error);
        renderPrintableMap(data, [], "Traçado das ruas indisponível");
        setPrintReady(true);
        updateCoverage(new Set(), data.ruas.length, 0, 0, true);
      }
    }
  }

  function escapeHtml(value) {
    const span = document.createElement("span");
    span.textContent = value;
    return span.innerHTML;
  }

  function totalTeamsFrom(streets) {
    return Math.max(...streets.map((street) => street.equipe), 1);
  }

  function preparePrint() {
    printDetailsState = [...document.querySelectorAll(".team-card")].map((card) => ({
      card,
      open: card.open,
    }));
    printDetailsState.forEach(({ card }) => { card.open = true; });
  }

  function restoreAfterPrint() {
    printDetailsState.forEach(({ card, open }) => { card.open = open; });
    printDetailsState = [];
    setMapMode(currentMapMode, false);
  }

  function applyTeamColors() {
    const cards = [...document.querySelectorAll(".team-card")];
    cards.forEach((card) => {
      card.style.setProperty("--team-color", teamColor(Number(card.dataset.team)));
    });
  }

  function teamText(card) {
    const name = card.querySelector(".team-name")?.textContent.trim() || "Equipe";
    const meta = card.querySelector(".team-meta")?.textContent.trim() || "";
    const streets = [...card.querySelectorAll(".street-row")].map((row) => {
      const parts = row.querySelectorAll("span, strong");
      return `- ${parts[0]?.textContent.trim()} (${parts[1]?.textContent.trim()} domicílios)`;
    });
    return `${name} — ${meta}\n${streets.join("\n")}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    showMessage("Rotas copiadas.");
  }

  function showMessage(text) {
    const message = document.getElementById("message");
    if (!message) return;
    message.textContent = text;
    message.hidden = false;
    clearTimeout(showMessage.timeout);
    showMessage.timeout = setTimeout(() => { message.hidden = true; }, 3200);
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMap();
    setMapControlsReady(false);
    const form = document.getElementById("filtros");
    if (form) window.setTimeout(() => form.requestSubmit(), 100);
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches("#municipioSelect")) {
      currentMapData = null;
      setMapControlsReady(false);
      document.getElementById("resultados").innerHTML = `
        <div class="empty-state"><span class="empty-number">02</span>
        <h2>Agora escolha um bairro</h2><p>A lista foi atualizada para o município selecionado.</p></div>`;
      clearMap();
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "print") {
      window.print();
      return;
    }
    if (button.dataset.action === "fit-municipality") {
      setMapMode("municipality");
      return;
    }
    if (button.dataset.action === "fit-neighborhood") {
      setMapMode("neighborhood");
      return;
    }
    if (button.dataset.action === "fit-heat") {
      setMapMode("heat");
      return;
    }
    if (button.dataset.action === "copy-team") {
      const card = button.closest(".team-card");
      if (card) copyText(teamText(card));
      return;
    }
    if (button.dataset.action === "copy-all") {
      const title = document.querySelector(".results-heading h2")?.textContent.trim() || "Divisão de rotas";
      const teams = [...document.querySelectorAll(".team-card")].map(teamText);
      copyText(`${title}\n\n${teams.join("\n\n")}`);
    }
  });

  document.body.addEventListener("htmx:afterSwap", (event) => {
    if (event.detail.target.id === "resultados") renderMap();
  });

  document.body.addEventListener("htmx:responseError", (event) => {
    const status = event.detail.xhr.status;
    showMessage(`Não foi possível concluir a operação (${status}).`);
  });

  window.addEventListener("beforeprint", preparePrint);
  window.addEventListener("afterprint", restoreAfterPrint);
})();
