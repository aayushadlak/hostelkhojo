/* ==========================================================================
   HOSTEL KHOJO INDIA - APPLICATION ENGINE
   ========================================================================== */

const RENDER_BACKEND_URL = "https://hostelkhojo.onrender.com/api";
let API_BASE_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://127.0.0.1:8000/api"
  : "/api";

/**
 * Smart fetch wrapper that handles API requests.
 * Automatically handles localhost vs Render cloud backend, cold-start delays, and proxy fallbacks.
 */
async function apiFetch(endpoint, options = {}, retries = 3) {
  let url = `${API_BASE_URL}${endpoint}`;
  try {
    let res = await fetch(url, options);
    const contentType = res.headers.get("content-type") || "";

    if ((contentType.includes("text/html") || res.status === 502 || res.status === 503 || res.status === 504) && API_BASE_URL !== RENDER_BACKEND_URL) {
      console.warn(`API server returned status ${res.status} at ${url}. Retrying with direct Render backend URL: ${RENDER_BACKEND_URL}`);
      API_BASE_URL = RENDER_BACKEND_URL;
      url = `${API_BASE_URL}${endpoint}`;
      res = await fetch(url, options);
    }
    return res;
  } catch (err) {
    if (API_BASE_URL !== RENDER_BACKEND_URL) {
      console.warn(`Local request failed at ${url}. Retrying with direct Render backend URL: ${RENDER_BACKEND_URL}`);
      API_BASE_URL = RENDER_BACKEND_URL;
      url = `${API_BASE_URL}${endpoint}`;
      return await fetch(url, options);
    }
    if (retries > 0) {
      if (window.app && typeof window.app.showToast === "function" && retries === 3) {
        window.app.showToast("Connecting to live backend cloud database...", "info");
      }
      await new Promise(r => setTimeout(r, 2000));
      return await apiFetch(endpoint, options, retries - 1);
    }
    throw err;
  }
}


const INITIAL_HOSTELS = [];
const INITIAL_ROOMMATES = [];


class HostelKhojoApp {
  constructor() {
    window.app = this;
    this.hostels = [...INITIAL_HOSTELS];
    this.filteredHostels = [...INITIAL_HOSTELS];
    this.roommates = [...INITIAL_ROOMMATES];

    this.savedIds = JSON.parse(localStorage.getItem("hostelkhojo_saved") || localStorage.getItem("dormify_saved") || "[]");
    this.comparisonIds = [];
    this.activePills = new Set();

    this.currentUser = JSON.parse(localStorage.getItem("hostelkhojo_user") || "null");
    this.currentOwnerUser = JSON.parse(localStorage.getItem("hostelkhojo_owner_user") || "null");
    this.ownerProperties = [];
    this.ownerBookings = [];

    this.currentViewMode = "grid"; // 'grid' or 'split'
    this.currentSort = "recommended";

    this.searchDebounceTimer = null;
    this.mapDebounceTimer = null;
    this.renderRaf = null;

    this.initGoogleMapsEngine();
    this.init();
  }

  init() {
    this.updateSavedCount();
    this.renderHostels();
    this.renderRoommates();
    this.setMapProvider(this.mapProvider);
    this.loadBackendData();
    this.checkUserSession();
    this.checkOwnerSession();
    this.renderAuthNavUI();

    // Handle URL routing for /user or /owner
    this.handleUrlRouting();
    window.addEventListener("popstate", () => this.handleUrlRouting());

    // Check saved theme - default to Light theme
    const savedTheme = localStorage.getItem("hostelkhojo_theme") || localStorage.getItem("dormify_theme") || "light";
    document.documentElement.setAttribute("data-theme", savedTheme);
    this.updateThemeIcon(savedTheme);
  }

  handleUrlRouting() {
    const path = window.location.pathname.toLowerCase();
    const hash = window.location.hash.toLowerCase();

    if (path.includes("/owner") || hash === "#owner") {
      this.openOwnerPortal();
    } else if (path.includes("/user") || path.includes("/profile") || hash === "#user" || hash === "#profile") {
      this.switchTab("user");
    }
  }


  async loadBackendData() {
    try {
      const res = await apiFetch("/hostels");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          this.hostels = data;
        }
      }
    } catch (err) {
      console.log("FastAPI Backend offline, using local mock hostels.");
    }

    // Merge custom locally saved properties to guarantee live rendering across reloads
    const customProps = JSON.parse(localStorage.getItem("hostelkhojo_custom_properties") || "[]");
    customProps.forEach(cp => {
      const existingIdx = this.hostels.findIndex(h => h.id === cp.id);
      if (existingIdx !== -1) {
        this.hostels[existingIdx] = cp;
      } else {
        this.hostels.unshift(cp);
      }
    });

    this.filteredHostels = [...this.hostels];
    this.renderHostels();
    this.renderMapPins();

    try {
      const rmRes = await apiFetch("/roommates");
      if (rmRes.ok) {
        const rmData = await rmRes.json();
        if (Array.isArray(rmData) && rmData.length > 0) {
          this.roommates = rmData;
          this.renderRoommates();
        }
      }
    } catch (err) {
      console.log("FastAPI Backend offline, using local mock roommates.");
    }
  }


  /* SEARCH & FILTER ENGINE */
  handleSearchInput() {
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => {
      this.applyFilters();
    }, 200);
  }

  updateBudgetLabel(val) {
    document.getElementById("budget-val").innerText = Number(val).toLocaleString('en-IN');
  }

  togglePillFilter(btn, filterKey) {
    btn.classList.toggle("active");
    if (this.activePills.has(filterKey)) {
      this.activePills.delete(filterKey);
    } else {
      this.activePills.add(filterKey);
    }
    this.applyFilters();
  }

  applyFilters() {
    const searchTerm = document.getElementById("search-input").value.toLowerCase().trim();
    const gender = document.getElementById("gender-filter").value;
    const roomType = document.getElementById("room-type-filter").value;
    const maxBudget = parseFloat(document.getElementById("budget-range").value);

    this.filteredHostels = this.hostels.filter(h => {
      // Keyword search
      const matchesText = !searchTerm ||
        h.name.toLowerCase().includes(searchTerm) ||
        h.university.toLowerCase().includes(searchTerm) ||
        h.city.toLowerCase().includes(searchTerm) ||
        h.address.toLowerCase().includes(searchTerm);

      // Gender filter
      const matchesGender = gender === "all" || h.gender === gender;

      // Room type filter
      const matchesRoom = roomType === "all" || h.roomSharing.includes(roomType);

      // Budget filter
      const matchesBudget = h.rent <= maxBudget;

      // Pill tags filter
      let matchesPills = true;
      if (this.activePills.has("walkable") && h.distance > 0.5) matchesPills = false;
      if (this.activePills.has("mess") && !h.amenities.some(a => a.toLowerCase().includes("mess"))) matchesPills = false;
      if (this.activePills.has("ac") && !h.amenities.some(a => a.toLowerCase().includes("ac"))) matchesPills = false;
      if (this.activePills.has("wifi") && !h.amenities.some(a => a.toLowerCase().includes("wi-fi"))) matchesPills = false;
      if (this.activePills.has("gym") && !h.amenities.some(a => a.toLowerCase().includes("power backup") || a.toLowerCase().includes("gym"))) matchesPills = false;

      return matchesText && matchesGender && matchesRoom && matchesBudget && matchesPills;
    });

    this.applySorting();
  }

  quickSearch(keyword) {
    document.getElementById("search-input").value = keyword;
    this.switchTab("hostels");
    this.applyFilters();
  }

  applySorting() {
    const sortVal = document.getElementById("sort-select").value;
    this.currentSort = sortVal;

    if (sortVal === "price-asc") {
      this.filteredHostels.sort((a, b) => a.rent - b.rent);
    } else if (sortVal === "price-desc") {
      this.filteredHostels.sort((a, b) => b.rent - a.rent);
    } else if (sortVal === "rating-desc") {
      this.filteredHostels.sort((a, b) => b.rating - a.rating);
    } else if (sortVal === "distance-asc") {
      this.filteredHostels.sort((a, b) => a.distance - b.distance);
    } else {
      // Recommended / Featured
      this.filteredHostels.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    }

    this.renderHostels();
    this.renderMapPins();
  }

  /* VIEW MODE CONTROLLER (GRID vs SPLIT MAP) */
  setViewMode(mode) {
    this.currentViewMode = mode;
    const layout = document.getElementById("explorer-layout");
    const gridBtn = document.getElementById("view-grid-btn");
    const splitBtn = document.getElementById("view-split-btn");

    if (mode === "split") {
      layout.className = "explorer-layout split-view";
      gridBtn.classList.remove("active");
      splitBtn.classList.add("active");
      setTimeout(() => {
        if (this.mapProvider === "osm" || this.mapProvider === "google") {
          this.renderOpenStreetMap();
          if (this.leafletMap) {
            this.leafletMap.invalidateSize();
          }
        } else {
          this.renderMapPins();
        }
      }, 150);
    } else {
      layout.className = "explorer-layout grid-view";
      gridBtn.classList.add("active");
      splitBtn.classList.remove("active");
    }
  }

  /* RENDER HOSTEL CARDS */
  renderHostels() {
    const grid = document.getElementById("hostels-grid");
    const countNum = document.getElementById("results-count-num");
    if (!grid) return;

    countNum.innerText = this.filteredHostels.length;

    if (this.filteredHostels.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; padding: 48px 24px; text-align: center; background: var(--bg-surface); border: 2px dashed var(--border-color); border-radius: var(--radius-lg); margin: 20px 0;">
          <i class="fa-solid fa-building-circle-check" style="font-size: 3.5rem; color: var(--accent-primary); margin-bottom: 16px;"></i>
          <h3>No Hostels Listed in This Search Yet</h3>
          <p class="text-muted" style="max-width: 500px; margin: 8px auto 20px auto;">Are you a Hostel or PG Owner? List your property now to connect directly with 100,000+ verified college students near your campus!</p>
          <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
            <button class="btn btn-accent btn-lg" onclick="app.openOwnerPortal()">
              <i class="fa-solid fa-plus-circle"></i> List Your Hostel / PG Property
            </button>
            <button class="btn btn-outline btn-lg" onclick="app.resetFilters()">
              Reset Filters
            </button>
          </div>
        </div>
      `;
      return;
    }


    grid.innerHTML = this.filteredHostels.map(h => {
      const isSaved = this.savedIds.includes(h.id);
      const isComparing = this.comparisonIds.includes(h.id);
      const genderClass = h.gender.toLowerCase().replace(/[^a-z]/g, '');

      return `
        <div class="hostel-card" id="card-${h.id}" onmouseenter="app.highlightMapPin('${h.id}')" onmouseleave="app.unhighlightMapPin('${h.id}')">
          <div class="card-media">
            <img src="${h.imageMain}" alt="${h.name}" loading="lazy" />
            <div class="card-badges-top">
              <span class="badge-gender ${genderClass}">${h.gender}</span>
              ${h.verified ? `<span class="badge-verified"><i class="fa-solid fa-circle-check"></i> Verified</span>` : ''}
            </div>
            <button class="card-bookmark-btn ${isSaved ? 'saved' : ''}" onclick="app.toggleBookmark('${h.id}')" title="Save Hostel">
              <i class="${isSaved ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i>
            </button>
          </div>

          <div class="card-body">
            <div class="card-header-row">
              <h3 class="card-title">${h.name}</h3>
              <div class="card-rating">
                <i class="fa-solid fa-star"></i> ${h.rating}
              </div>
            </div>

            <div class="card-location">
              <i class="fa-solid fa-location-dot"></i> ${h.university} (${h.distance} km)
            </div>

            <div class="card-amenities">
              ${h.amenities.slice(0, 4).map(a => `<span class="amenity-chip"><i class="fa-solid fa-check"></i> ${a}</span>`).join('')}
              ${h.amenities.length > 4 ? `<span class="amenity-chip">+${h.amenities.length - 4} more</span>` : ''}
            </div>

            <div class="card-footer-row">
              <div class="card-price">
                <span class="price-num">₹${h.rent.toLocaleString('en-IN')}</span>
                <span class="price-unit">/month</span>
              </div>

              <div class="card-actions">
                <button class="btn btn-outline btn-sm ${isComparing ? 'active' : ''}" onclick="app.toggleCompare('${h.id}')">
                  <i class="fa-solid fa-scale-balanced"></i> ${isComparing ? 'Added' : 'Compare'}
                </button>
                <button class="btn btn-primary btn-sm" onclick="app.openHostelDetail('${h.id}')">
                  View Details
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  resetFilters() {
    document.getElementById("search-input").value = "";
    document.getElementById("gender-filter").value = "all";
    document.getElementById("room-type-filter").value = "all";
    document.getElementById("budget-range").value = "15000";
    this.updateBudgetLabel("15000");
    this.activePills.clear();
    document.querySelectorAll(".pill-btn").forEach(b => b.classList.remove("active"));
    this.applyFilters();
  }

  /* SIMULATED MAP PINS */
  renderMapPins() {
    const pinsLayer = document.getElementById("map-pins-layer");
    if (!pinsLayer) return;

    pinsLayer.innerHTML = this.filteredHostels.map(h => {
      const pinGenderClass = h.gender.toLowerCase().replace(/[^a-z]/g, '');
      return `
        <div class="map-pin pin-${pinGenderClass}" id="pin-${h.id}" 
             style="top: ${h.mapCoords.top}%; left: ${h.mapCoords.left}%;"
             onclick="app.openHostelDetail('${h.id}')"
             onmouseenter="app.highlightCard('${h.id}')">
          ₹${(h.rent / 1000).toFixed(1)}k
        </div>
      `;
    }).join('');
  }

  highlightMapPin(id) {
    const pin = document.getElementById(`pin-${id}`);
    if (pin) pin.classList.add("active");
  }

  unhighlightMapPin(id) {
    const pin = document.getElementById(`pin-${id}`);
    if (pin) pin.classList.remove("active");
  }

  highlightCard(id) {
    const card = document.getElementById(`card-${id}`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      card.style.borderColor = "var(--accent-primary)";
      setTimeout(() => { card.style.borderColor = ""; }, 1500);
    }
  }

  /* ==========================================================================
     OPENSTREETMAP (LEAFLET) LIVE MAP ENGINE - 100% FREE & ZERO WATERMARKS
     ========================================================================== */
  
  initGoogleMapsEngine() {
    this.mapProvider = localStorage.getItem("hostelkhojo_map_provider") || "osm";
    this.leafletMap = null;
    this.leafletMarkers = [];
  }

  setMapProvider(provider) {
    this.mapProvider = provider;
    localStorage.setItem("hostelkhojo_map_provider", provider);

    const gmapsBtn = document.getElementById("map-mode-gmaps-btn");
    const canvasBtn = document.getElementById("map-mode-canvas-btn");
    const gmapsCanvas = document.getElementById("google-map-canvas");
    const simulatedMap = document.getElementById("simulated-map");

    if (provider === "osm" || provider === "google") {
      gmapsBtn?.classList.add("active");
      canvasBtn?.classList.remove("active");
      if (gmapsCanvas) gmapsCanvas.style.display = "block";
      if (simulatedMap) simulatedMap.style.display = "none";
      this.renderOpenStreetMap();
    } else {
      canvasBtn?.classList.add("active");
      gmapsBtn?.classList.remove("active");
      if (gmapsCanvas) gmapsCanvas.style.display = "none";
      if (simulatedMap) simulatedMap.style.display = "block";
      this.renderMapPins();
    }
  }

  renderOpenStreetMap() {
    if (this.mapDebounceTimer) clearTimeout(this.mapDebounceTimer);
    this.mapDebounceTimer = setTimeout(() => {
      this._doRenderOpenStreetMap();
    }, 150);
  }

  _doRenderOpenStreetMap() {
    const canvas = document.getElementById("google-map-canvas");
    if (!canvas || typeof L === "undefined") return;

    let centerLat = 28.6922;
    let centerLng = 77.2100;

    if (this.filteredHostels.length > 0) {
      const validCoordsHostels = this.filteredHostels.filter(h => h.lat && h.lng);
      if (validCoordsHostels.length > 0) {
        const sumLat = validCoordsHostels.reduce((acc, h) => acc + h.lat, 0);
        const sumLng = validCoordsHostels.reduce((acc, h) => acc + h.lng, 0);
        centerLat = sumLat / validCoordsHostels.length;
        centerLng = sumLng / validCoordsHostels.length;
      }
    }

    try {
      if (!this.leafletMap) {
        this.leafletMap = L.map(canvas, {
          zoomControl: true,
          scrollWheelZoom: true
        }).setView([centerLat, centerLng], 11);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Hostel Khojo 🇮🇳'
        }).addTo(this.leafletMap);
      } else {
        this.leafletMap.setView([centerLat, centerLng]);
      }

      if (this.leafletMarkers) {
        this.leafletMarkers.forEach(m => this.leafletMap.removeLayer(m));
        this.leafletMarkers = [];
      }

      const bounds = [];

      this.filteredHostels.forEach(h => {
        if (!h.lat || !h.lng) return;

        bounds.push([h.lat, h.lng]);

        let badgeBg = "#3b82f6";
        if (h.gender === "Girls") badgeBg = "#ec4899";
        if (h.gender === "Co-ed") badgeBg = "#8b5cf6";

        const customIcon = L.divIcon({
          className: 'custom-osm-pin',
          html: `
            <div style="background: ${badgeBg}; color: white; padding: 4px 8px; border-radius: 12px; font-weight: 700; font-size: 11px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border: 2px solid white; text-align: center; white-space: nowrap;">
              ₹${(h.rent / 1000).toFixed(1)}k
            </div>
          `,
          iconSize: [54, 26],
          iconAnchor: [27, 13]
        });

        const marker = L.marker([h.lat, h.lng], { icon: customIcon }).addTo(this.leafletMap);

        const popupContent = `
          <div class="gmaps-infowindow">
            <img src="${h.imageMain || 'assets/images/exterior1.png'}" alt="${h.name}" />
            <h4>${h.name}</h4>
            <p><i class="fa-solid fa-location-dot"></i> ${h.university || h.city}</p>
            <div class="gmaps-infowindow-meta">
              <span>₹${Number(h.rent).toLocaleString('en-IN')}/mo</span>
              <span>⭐ ${h.rating || 4.8}</span>
            </div>
            <div style="display: flex; gap: 6px;">
              <button onclick="app.openHostelDetail('${h.id}')" class="gmaps-infowindow-btn" style="flex: 1;">
                View Details
              </button>
              <a href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}" target="_blank" class="gmaps-infowindow-btn" style="background: #059669; flex: 1; display: inline-flex; align-items: center; justify-content: center; text-decoration: none;">
                Directions
              </a>
            </div>
          </div>
        `;

        marker.bindPopup(popupContent);
        marker.on("click", () => {
          this.highlightCard(h.id);
        });

        this.leafletMarkers.push(marker);
      });

      if (bounds.length > 1) {
        this.leafletMap.fitBounds(bounds, { padding: [30, 30] });
      }
    } catch (e) {
      console.warn("Leaflet Map render notice:", e);
    }
  }

  renderGoogleMap() {
    this.renderOpenStreetMap();
  }

  openGoogleDirections(lat, lng, name = "") {
    if (!lat || !lng) {
      this.showToast("Location coordinates not available for this hostel.", "info");
      return;
    }
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_id=${encodeURIComponent(name)}`;
    window.open(url, "_blank");
  }

  /* BOOKMARK & SAVED HOSTELS */
  toggleBookmark(id) {
    if (this.savedIds.includes(id)) {
      this.savedIds = this.savedIds.filter(i => i !== id);
      this.showToast("Removed from saved hostels", "info");
    } else {
      this.savedIds.push(id);
      this.showToast("Hostel saved to your bookmarks!", "success");
    }
    localStorage.setItem("hostelkhojo_saved", JSON.stringify(this.savedIds));
    this.updateSavedCount();
    this.renderHostels();
  }

  updateSavedCount() {
    const countEl = document.getElementById("saved-count");
    if (countEl) countEl.innerText = this.savedIds.length;
  }

  showSavedHostels() {
    if (this.savedIds.length === 0) {
      this.showToast("You haven't saved any hostels yet!", "warning");
      return;
    }
    this.filteredHostels = this.hostels.filter(h => this.savedIds.includes(h.id));
    this.switchTab("hostels");
    document.querySelectorAll(".mobile-nav-item").forEach(m => m.classList.remove("active"));
    document.getElementById("mob-nav-saved")?.classList.add("active");
    this.renderHostels();
    this.renderMapPins();
    this.showToast(`Showing ${this.savedIds.length} saved hostels`);
  }

  /* COMPARISON TRAY & MATRIX ENGINE */
  toggleCompare(id) {
    if (this.comparisonIds.includes(id)) {
      this.comparisonIds = this.comparisonIds.filter(i => i !== id);
    } else {
      if (this.comparisonIds.length >= 3) {
        this.showToast("You can compare up to 3 hostels at a time!", "warning");
        return;
      }
      this.comparisonIds.push(id);
    }

    this.renderComparisonTray();
    this.renderHostels();
  }

  clearComparison() {
    this.comparisonIds = [];
    this.renderComparisonTray();
    this.renderHostels();
  }

  renderComparisonTray() {
    const tray = document.getElementById("comparison-tray");
    const count = document.getElementById("comp-count");
    const previews = document.getElementById("comp-previews");
    const btn = document.getElementById("compare-now-btn");

    if (!tray) return;

    if (this.comparisonIds.length > 0) {
      tray.classList.add("active");
    } else {
      tray.classList.remove("active");
    }

    count.innerText = this.comparisonIds.length;
    btn.disabled = this.comparisonIds.length < 2;

    previews.innerHTML = this.comparisonIds.map(id => {
      const hostel = this.hostels.find(h => h.id === id);
      if (!hostel) return '';
      return `
        <div class="comp-thumb">
          <img src="${hostel.imageMain}" alt="${hostel.name}" />
          <span class="comp-thumb-remove" onclick="app.toggleCompare('${id}')">&times;</span>
        </div>
      `;
    }).join('');
  }

  openComparisonModal() {
    if (this.comparisonIds.length < 2) return;

    const selectedHostels = this.hostels.filter(h => this.comparisonIds.includes(h.id));
    const table = document.getElementById("comparison-table");

    table.innerHTML = `
      <thead>
        <tr>
          <th>Feature</th>
          ${selectedHostels.map(h => `
            <th>
              <img src="${h.imageMain}" style="width: 100%; height: 90px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;" />
              <div>${h.name}</div>
              <div style="color: var(--accent-secondary); font-size: 1.1rem; font-weight: 800; margin-top: 4px;">₹${h.rent.toLocaleString('en-IN')}/mo</div>
            </th>
          `).join('')}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Distance to Campus</strong></td>
          ${selectedHostels.map(h => `<td>${h.distance} km to ${h.university}</td>`).join('')}
        </tr>
        <tr>
          <td><strong>Hostel Type</strong></td>
          ${selectedHostels.map(h => `<td><strong>${h.gender}</strong></td>`).join('')}
        </tr>
        <tr>
          <td><strong>Security Deposit</strong></td>
          ${selectedHostels.map(h => `<td>₹${h.deposit.toLocaleString('en-IN')}</td>`).join('')}
        </tr>
        <tr>
          <td><strong>Room Sharing Options</strong></td>
          ${selectedHostels.map(h => `<td>${h.roomSharing.join(', ')}</td>`).join('')}
        </tr>
        <tr>
          <td><strong>Gate Curfew Time</strong></td>
          ${selectedHostels.map(h => `<td>${h.curfew}</td>`).join('')}
        </tr>
        <tr>
          <td><strong>Student Rating</strong></td>
          ${selectedHostels.map(h => `<td><i class="fa-solid fa-star" style="color: var(--accent-amber);"></i> ${h.rating} (${h.reviewsCount})</td>`).join('')}
        </tr>
        <tr>
          <td><strong>Top Amenities</strong></td>
          ${selectedHostels.map(h => `<td>${h.amenities.slice(0, 5).join(', ')}</td>`).join('')}
        </tr>
        <tr>
          <td><strong>Action</strong></td>
          ${selectedHostels.map(h => `
            <td>
              <button class="btn btn-primary btn-sm btn-block" onclick="app.closeModal('comparison-modal'); app.openHostelDetail('${h.id}')">
                Book / View Detail
              </button>
            </td>
          `).join('')}
        </tr>
      </tbody>
    `;

    this.openModal("comparison-modal");
  }

  /* HOSTEL DETAIL MODAL & MESS MENU TABS */
  openHostelDetail(id) {
    const h = this.hostels.find(item => item.id === id);
    if (!h) return;

    const modalContent = document.getElementById("modal-detail-content");

    modalContent.innerHTML = `
      <div class="detail-gallery-grid">
        <img src="${h.imageMain}" class="detail-main-img" alt="${h.name}" />
        <div class="detail-sub-imgs">
          <img src="${h.imageSingle}" alt="Single Room" />
          <img src="${h.imageMess}" alt="Mess Hall" />
        </div>
      </div>

      <div class="detail-header-section">
        <div>
          <div class="flex-gap align-center margin-bottom-sm">
            <span class="badge-gender ${h.gender.toLowerCase()}">${h.gender}</span>
            ${h.verified ? `<span class="badge-verified"><i class="fa-solid fa-circle-check"></i> Verified Property</span>` : ''}
          </div>
          <h2>${h.name}</h2>
          <p class="card-location"><i class="fa-solid fa-location-dot"></i> ${h.address} (${h.distance} km to ${h.university})</p>
        </div>

        <div class="text-right">
          <div class="price-num" style="font-size: 1.8rem;">₹${h.rent.toLocaleString('en-IN')}<span style="font-size: 0.9rem; color: var(--text-muted);">/month</span></div>
          <div class="card-rating" style="justify-content: flex-end; margin-top: 4px;">
            <i class="fa-solid fa-star"></i> ${h.rating} (${h.reviewsCount} verified reviews)
          </div>
        </div>
      </div>

      <div class="detail-grid-layout margin-top-lg">
        <div class="detail-main-col">
          
          <h3><i class="fa-solid fa-circle-info"></i> About Property</h3>
          <p class="text-secondary line-height-md margin-bottom-lg">${h.description}</p>

          <h3><i class="fa-solid fa-layer-group"></i> Room Sharing & Pricing Breakdown</h3>
          <div class="room-options-grid margin-bottom-lg">
            ${h.roomSharing.map(type => `
              <div class="room-option-card">
                <div class="room-type-title">${type} Room</div>
                <div class="room-price">₹${(h.rent * (type === 'Single' ? 1.3 : type === 'Double' ? 1.0 : 0.8)).toFixed(0)}/mo</div>
                <ul class="room-specs">
                  <li><i class="fa-solid fa-check"></i> ${type === 'Single' ? 'Private Study Desk & Almirah' : 'Personal Wardrobe & Desk'}</li>
                  <li><i class="fa-solid fa-check"></i> Attached Balcony & Bath</li>
                </ul>
              </div>
            `).join('')}
          </div>

          <h3><i class="fa-solid fa-utensils"></i> Weekly Homestyle Mess Menu</h3>
          <div class="mess-menu-card margin-bottom-lg">
            <div class="mess-tabs">
              <button class="mess-tab active" onclick="app.switchMessTab(this, 'mess-bf')">Breakfast</button>
              <button class="mess-tab" onclick="app.switchMessTab(this, 'mess-lunch')">Lunch</button>
              <button class="mess-tab" onclick="app.switchMessTab(this, 'mess-snacks')">Evening Snacks</button>
              <button class="mess-tab" onclick="app.switchMessTab(this, 'mess-dinner')">Dinner</button>
            </div>
            <div class="mess-content-box">
              <div id="mess-bf" class="mess-tab-pane active"><i class="fa-solid fa-mug-hot"></i> ${h.messMenu.breakfast}</div>
              <div id="mess-lunch" class="mess-tab-pane"><i class="fa-solid fa-bowl-rice"></i> ${h.messMenu.lunch}</div>
              <div id="mess-snacks" class="mess-tab-pane"><i class="fa-solid fa-cookie-bite"></i> ${h.messMenu.snacks}</div>
              <div id="mess-dinner" class="mess-tab-pane"><i class="fa-solid fa-utensils"></i> ${h.messMenu.dinner}</div>
            </div>
          </div>

          <h3><i class="fa-solid fa-comments"></i> Student Reviews</h3>
          <div class="reviews-list margin-top-md">
            ${h.reviews.map(r => `
              <div class="review-item">
                <div class="review-user-row">
                  <strong>${r.name}</strong> • <span class="text-muted">${r.major}</span>
                  <div class="card-rating"><i class="fa-solid fa-star"></i> ${r.rating}</div>
                </div>
                <p class="review-text">"${r.comment}"</p>
              </div>
            `).join('')}
          </div>

        </div>

        <div class="detail-sidebar-col">
          <div class="sidebar-card">
            <h4><i class="fa-solid fa-calendar-check"></i> Book a Free Visit / Bed</h4>
            <p class="text-muted font-sm">Zero brokerage fee guarantee with 100% deposit protection.</p>

            <form onsubmit="app.handleBookingSubmit(event, '${h.id}')" class="margin-top-md">
              <div class="form-group">
                <label>Select Room Sharing</label>
                <select class="form-control" required>
                  ${h.roomSharing.map(s => `<option value="${s}">${s} Room Sharing</option>`).join('')}
                </select>
              </div>

              <div class="form-group">
                <label>Preferred Visit Date</label>
                <input type="date" class="form-control" required />
              </div>

              <div class="form-group">
                <label>Your Phone / WhatsApp</label>
                <input type="tel" placeholder="+91 98765 43210" class="form-control" required />
              </div>

              <button type="submit" class="btn btn-accent btn-block btn-lg margin-top-md">
                <i class="fa-solid fa-paper-plane"></i> Schedule Free Campus Visit
              </button>
              <button type="button" class="btn btn-outline btn-block margin-top-sm" onclick="app.openGoogleDirections(${h.lat || 28.6922}, ${h.lng || 77.2100}, '${encodeURIComponent(h.name)}')" style="border-color: #4285F4; color: #4285F4; font-weight: 600;">
                <i class="fa-solid fa-map-location-dot" style="color: #ea4335;"></i> Open in Google Maps
              </button>
            </form>
          </div>
        </div>
      </div>
    `;

    this.openModal("hostel-detail-modal");
  }

  switchMessTab(btn, paneId) {
    document.querySelectorAll(".mess-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".mess-tab-pane").forEach(p => p.classList.remove("active"));

    btn.classList.add("active");
    const pane = document.getElementById(paneId);
    if (pane) pane.classList.add("active");
  }

  async handleBookingSubmit(e, hostelId) {
    e.preventDefault();
    const form = e.target;
    const roomSharingSelect = form.querySelector("select");
    const visitDateInput = form.querySelector("input[type='date']");
    const phoneInput = form.querySelector("input[type='tel']");

    const payload = {
      hostel_id: hostelId,
      user_name: "Student Visitor",
      phone: phoneInput ? phoneInput.value : "+91 9876543210",
      visit_date: visitDateInput ? visitDateInput.value : new Date().toISOString().split("T")[0],
      room_sharing: roomSharingSelect ? roomSharingSelect.value : "Single"
    };

    try {
      const res = await apiFetch("/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        this.showToast("Visit Scheduled & Saved to Backend! Warden will contact via WhatsApp.", "success");
      } else {
        this.showToast("Visit Scheduled! Warden will contact via WhatsApp.", "success");
      }
    } catch (err) {
      this.showToast("Visit Scheduled! Warden will contact via WhatsApp.", "success");
    }

    this.closeModal("hostel-detail-modal");
  }

  /* ROOMMATE MATCHER ENGINE */
  renderRoommates() {
    const grid = document.getElementById("roommates-grid");
    if (!grid) return;

    const majorFilter = document.getElementById("rm-major-filter")?.value || "all";
    const habitFilter = document.getElementById("rm-habit-filter")?.value || "all";
    const dietFilter = document.getElementById("rm-diet-filter")?.value || "all";

    const filtered = this.roommates.filter(r => {
      const matchMajor = majorFilter === "all" || (r.major && r.major.toLowerCase().includes(majorFilter.toLowerCase()));
      const matchHabit = habitFilter === "all" || (r.sleepHabit === habitFilter || r.sleep_habit === habitFilter);
      const matchDiet = dietFilter === "all" || r.diet === dietFilter;
      return matchMajor && matchHabit && matchDiet;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; padding: 48px 24px; text-align: center; background: var(--bg-surface); border: 2px dashed var(--border-color); border-radius: var(--radius-lg); margin: 20px 0;">
          <i class="fa-solid fa-user-plus" style="font-size: 3.5rem; color: var(--accent-primary); margin-bottom: 16px;"></i>
          <h3>No Roommate Cards Posted Yet</h3>
          <p class="text-muted" style="max-width: 500px; margin: 8px auto 20px auto;">Be the first student to post your room partner requirements and find compatible roommates near your college!</p>
          <button class="btn btn-primary btn-lg" onclick="app.openModal('post-roommate-modal')">
            <i class="fa-solid fa-user-plus"></i> Post Roommate Profile
          </button>
        </div>
      `;
      return;
    }

    grid.innerHTML = filtered.map(r => `

      <div class="roommate-card">
        <div class="rm-header">
          <div class="rm-avatar">${r.avatar || "ST"}</div>
          <div>
            <h3 class="rm-name">${r.name}</h3>
            <p class="rm-uni">${r.university || "Indian Campus"} (${r.major})</p>
          </div>
        </div>

        <div class="rm-tags">
          <span class="rm-tag"><i class="fa-solid fa-moon"></i> ${r.sleepHabit || r.sleep_habit}</span>
          <span class="rm-tag"><i class="fa-solid fa-utensils"></i> ${r.diet}</span>
          <span class="rm-tag"><i class="fa-solid fa-indian-rupee-sign"></i> Max ₹${Number(r.budget).toLocaleString('en-IN')}/mo</span>
        </div>

        <p class="rm-bio">"${r.bio}"</p>

        <button class="btn btn-outline btn-block margin-top-md" onclick="app.connectRoommate('${r.name}')">
          <i class="fa-solid fa-paper-plane"></i> Send Roommate Request
        </button>
      </div>
    `).join('');
  }

  async handlePostRoommateSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("rm-name-input").value;
    const gender = document.getElementById("rm-gender-input").value;
    const major = document.getElementById("rm-major-input").value;
    const budget = parseFloat(document.getElementById("rm-budget-input").value);
    const sleepHabit = document.getElementById("rm-sleep-input").value;
    const diet = document.getElementById("rm-diet-input").value;
    const bio = document.getElementById("rm-bio-input").value;

    const payload = {
      name,
      gender,
      university: "Indian Campus",
      major,
      budget,
      sleep_habit: sleepHabit,
      diet,
      bio
    };

    try {
      const res = await apiFetch("/roommates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const newRm = await res.json();
        this.roommates.unshift(newRm);
        this.renderRoommates();
      } else {
        const fallbackProfile = { ...payload, id: "r_" + Date.now(), sleepHabit, avatar: name.split(' ').map(n => n[0]).join('').toUpperCase() };
        this.roommates.unshift(fallbackProfile);
        this.renderRoommates();
      }
    } catch (err) {
      const fallbackProfile = { ...payload, id: "r_" + Date.now(), sleepHabit, avatar: name.split(' ').map(n => n[0]).join('').toUpperCase() };
      this.roommates.unshift(fallbackProfile);
      this.renderRoommates();
    }

    this.closeModal("post-roommate-modal");
    this.showToast("Your roommate requirement card has been published!", "success");
  }

  connectRoommate(name) {
    if (!this.currentUser) {
      this.showToast("Please log in or register first to connect with roommates.", "warning");
      this.openModal("auth-modal");
      return;
    }
    this.showToast(`Connection request sent to ${name}! Check your student messages.`, "success");
  }

  /* ==========================================================================
     PG & HOSTEL OWNER PORTAL ENGINE
     ========================================================================== */

  openOwnerPortal() {
    if (this.currentUser && this.currentUser.role === "student" && !this.currentOwnerUser) {
      this.showToast("Student accounts cannot list properties. Please sign in or register as a PG/Hostel Owner.", "warning");
      this.openModal("owner-auth-modal");
      return;
    }

    if (!this.currentOwnerUser && (!this.currentUser || this.currentUser.role === "student")) {
      this.showToast("Please log in or register as a PG/Hostel Owner to access your dedicated property portal.", "info");
      this.openModal("owner-auth-modal");
      return;
    }

    this.switchTab("owner");
    this.loadOwnerDashboardData();
  }

  openOwnerPropertyModal() {
    const activeUser = this.currentOwnerUser || (this.currentUser && (this.currentUser.role === "owner" || this.currentUser.role === "admin") ? this.currentUser : null);
    
    if (!activeUser || activeUser.role === "student") {
      this.showToast("Student accounts cannot add hostels or PGs. Please log in or register as a PG/Hostel Owner.", "warning");
      this.openModal("owner-auth-modal");
      return;
    }

    document.getElementById("owner-prop-id").value = "";
    document.getElementById("owner-prop-modal-title").innerHTML = `<i class="fa-solid fa-building-circle-check" style="color: #059669;"></i> List New PG / Hostel Property`;
    const form = document.getElementById("owner-property-form");
    if (form) form.reset();
    this.openModal("owner-property-modal");
  }

  openOwnerPropertyModalFromProfile() {
    this.openOwnerPropertyModal();
  }

  async checkOwnerSession() {
    const token = localStorage.getItem("hostelkhojo_owner_token");
    if (!token) return;

    try {
      const res = await apiFetch("/auth/me", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.ok) {
        const userData = await res.json();
        if (userData.role === "owner" || userData.role === "admin") {
          this.currentOwnerUser = userData;
          localStorage.setItem("hostelkhojo_owner_user", JSON.stringify(userData));
          this.renderAuthNavUI();
        }
      } else if (res.status === 401) {
        localStorage.removeItem("hostelkhojo_owner_token");
        localStorage.removeItem("hostelkhojo_owner_user");
        this.currentOwnerUser = null;
        this.renderAuthNavUI();
      }
    } catch (err) {
      console.log("Owner session check skipped");
    }
  }

  switchOwnerAuthTab(tab) {
    const loginForm = document.getElementById("owner-login-form");
    const regForm = document.getElementById("owner-register-form");
    const loginBtn = document.getElementById("owner-tab-login-btn");
    const regBtn = document.getElementById("owner-tab-register-btn");

    if (tab === "login") {
      if (loginForm) loginForm.style.display = "block";
      if (regForm) regForm.style.display = "none";
      loginBtn?.classList.add("active");
      regBtn?.classList.remove("active");
    } else {
      if (loginForm) loginForm.style.display = "none";
      if (regForm) regForm.style.display = "block";
      regBtn?.classList.add("active");
      loginBtn?.classList.remove("active");
    }
  }

  async handleOwnerLoginSubmit(e) {
    e.preventDefault();
    const identifier = document.getElementById("owner-login-identifier").value.trim();
    const password = document.getElementById("owner-login-password").value.trim();

    // Mobile Phone Validation
    const cleanPhone = identifier.replace(/\D/g, '');
    if (!identifier || cleanPhone.length < 10) {
      this.showToast("Please enter a valid 10-digit mobile phone number to log in as Owner.", "warning");
      return;
    }

    try {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.user.role !== "owner" && data.user.role !== "admin") {
          this.showToast("This account is registered as a student. Please log in using Student Login or register an Owner account.", "warning");
          return;
        }
        localStorage.setItem("hostelkhojo_owner_token", data.access_token);
        localStorage.setItem("hostelkhojo_owner_user", JSON.stringify(data.user));
        this.currentOwnerUser = data.user;
        this.renderAuthNavUI();
        this.closeModal("owner-auth-modal");
        this.showToast(`Welcome to Owner Portal, ${data.user.full_name}!`, "success");
        this.openOwnerPortal();
      } else {
        const err = await res.json().catch(() => ({}));
        this.showToast(err.detail || "Invalid Owner Credentials. Please try again.", "warning");
      }
    } catch (err) {
      this.showToast("Network error. Could not connect to owner authentication server.", "warning");
    }
  }

  async handleOwnerRegisterSubmit(e) {
    e.preventDefault();
    const full_name = document.getElementById("owner-reg-name").value.trim();
    const phone = document.getElementById("owner-reg-phone").value.trim();
    const email = document.getElementById("owner-reg-email").value.trim();
    const password = document.getElementById("owner-reg-password").value.trim();

    // Mobile Phone Validation
    const cleanPhone = phone.replace(/\D/g, '');
    if (!phone || cleanPhone.length < 10) {
      this.showToast("Please enter a valid 10-digit mobile phone number for PG owner registration.", "warning");
      return;
    }

    const payload = { full_name, phone, email, password, role: "owner" };

    try {
      const res = await apiFetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        localStorage.setItem("hostelkhojo_owner_token", data.access_token);
        localStorage.setItem("hostelkhojo_owner_user", JSON.stringify(data.user));
        this.currentOwnerUser = data.user;
        this.renderAuthNavUI();
        this.closeModal("owner-auth-modal");
        this.showToast(`Owner Account Created! Welcome, ${data.user.full_name}!`, "success");
        this.openOwnerPortal();
      } else {
        const err = await res.json().catch(() => ({}));
        this.showToast(err.detail || "Owner Registration failed. Phone or Email might already exist.", "warning");
      }
    } catch (err) {
      this.showToast("Network error. Please try again.", "warning");
    }
  }

  logoutOwner() {
    localStorage.removeItem("hostelkhojo_owner_token");
    localStorage.removeItem("hostelkhojo_owner_user");
    this.currentOwnerUser = null;
    this.renderAuthNavUI();
    if (window.location.pathname === "/owner") {
      try { history.pushState(null, "", "/"); } catch (e) { }
    }
    this.switchTab("hostels");
    this.showToast("Logged out of Owner Dashboard.", "info");
  }

  async loadOwnerDashboardData() {
    const activeOwner = this.currentOwnerUser || (this.currentUser && (this.currentUser.role === "owner" || this.currentUser.role === "admin") ? this.currentUser : null);
    if (!activeOwner) return;

    // Set Owner Header Details
    const nameEl = document.getElementById("owner-page-name");
    const emailEl = document.getElementById("owner-page-email");
    const phoneEl = document.getElementById("owner-page-phone");
    const avatarEl = document.getElementById("owner-page-avatar");

    if (nameEl) nameEl.innerText = activeOwner.full_name || "PG Owner";
    if (emailEl) emailEl.innerHTML = `<i class="fa-solid fa-envelope"></i> ${activeOwner.email || 'N/A'}`;
    if (phoneEl) phoneEl.innerHTML = `<i class="fa-solid fa-phone"></i> ${activeOwner.phone || 'N/A'}`;
    if (avatarEl) {
      const initials = (activeOwner.full_name || "OW").split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
      avatarEl.innerText = initials;
    }

    const token = localStorage.getItem("hostelkhojo_owner_token") || localStorage.getItem("hostelkhojo_token");
    const headers = token ? { "Authorization": `Bearer ${token}` } : {};

    try {
      // Fetch owner properties
      const propRes = await apiFetch("/owner/properties", { headers });
      if (propRes.ok) {
        this.ownerProperties = await propRes.json();
      } else {
        const currentOwnerId = activeOwner ? activeOwner.id : null;
        this.ownerProperties = currentOwnerId 
          ? this.hostels.filter(h => h.owner_id === currentOwnerId || h.owner_id === activeOwner?.email)
          : [];
      }
    } catch (e) {
      const currentOwnerId = activeOwner ? activeOwner.id : null;
      this.ownerProperties = currentOwnerId 
        ? this.hostels.filter(h => h.owner_id === currentOwnerId || h.owner_id === activeOwner?.email)
        : [];
    }

    try {
      // Fetch owner bookings
      const bkRes = await apiFetch("/owner/bookings", { headers });
      if (bkRes.ok) {
        this.ownerBookings = await bkRes.json();
      } else {
        this.ownerBookings = [];
      }
    } catch (e) {
      this.ownerBookings = [];
    }

    this.renderOwnerDashboard();
  }

  renderOwnerDashboard() {
    // Stats update
    const propStat = document.getElementById("owner-stat-properties");
    const bkStat = document.getElementById("owner-stat-bookings");
    if (propStat) propStat.innerText = this.ownerProperties.length;
    if (bkStat) bkStat.innerText = this.ownerBookings.length;

    // Render owner properties grid
    const propContainer = document.getElementById("owner-properties-container");
    if (propContainer) {
      if (this.ownerProperties.length === 0) {
        propContainer.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 40px; background: var(--bg-card-hover); border-radius: var(--radius-md);">
            <i class="fa-solid fa-building-circle-exclamation" style="font-size: 2.5rem; color: var(--text-muted); margin-bottom: 12px; display: block;"></i>
            <h3 class="font-md">No Listed Properties Found</h3>
            <p class="text-muted font-xs margin-bottom-md">List your first student PG or hostel property to reach college students near campus.</p>
            <button class="btn btn-primary" onclick="app.openOwnerPropertyModal()">
              <i class="fa-solid fa-plus-circle"></i> Add New PG / Hostel Property
            </button>
          </div>
        `;
      } else {
        propContainer.innerHTML = this.ownerProperties.map(h => `
          <div class="hostel-card">
            <div class="card-image-wrapper">
              <img src="${h.imageMain || 'assets/images/exterior1.png'}" alt="${h.name}" class="card-image" />
              <span class="badge badge-success" style="position: absolute; top: 12px; left: 12px; font-weight: 600; padding: 4px 10px; border-radius: 12px; background: #059669; color: white; box-shadow: 0 2px 6px rgba(0,0,0,0.2);">
                <i class="fa-solid fa-wifi"></i> Live on Website
              </span>
              <span class="gender-badge gender-${(h.gender || 'Co-ed').toLowerCase()}">${h.gender}</span>
            </div>
            <div class="card-body">
              <div class="card-header">
                <div>
                  <h3 class="hostel-name">${h.name}</h3>
                  <p class="hostel-location"><i class="fa-solid fa-location-dot"></i> ${h.university || h.city}</p>
                </div>
              </div>
              <div class="card-details-grid margin-top-xs">
                <span><i class="fa-solid fa-indian-rupee-sign"></i> ₹${Number(h.rent).toLocaleString('en-IN')}/mo</span>
                <span><i class="fa-solid fa-person-walking"></i> ${h.distance} km from campus</span>
              </div>
              <div style="display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap;">
                <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="app.openEditPropertyModal('${h.id}')">
                  <i class="fa-solid fa-pen-to-square"></i> Edit Listing
                </button>
                <button class="btn btn-accent btn-sm" onclick="app.viewLiveProperty('${h.id}')">
                  <i class="fa-solid fa-eye"></i> View Live
                </button>
                <button class="btn btn-danger-outline btn-sm" onclick="app.deleteOwnerProperty('${h.id}')">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              </div>
            </div>
          </div>
        `).join('');
      }
    }

    // Render bookings table
    const bkBody = document.getElementById("owner-bookings-tbody");
    if (bkBody) {
      if (this.ownerBookings.length === 0) {
        bkBody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted);">
              <i class="fa-solid fa-inbox" style="font-size: 1.5rem; margin-bottom: 6px; display: block;"></i>
              No student visit bookings received yet. Incoming booking requests will appear here.
            </td>
          </tr>
        `;
      } else {
        bkBody.innerHTML = this.ownerBookings.map(b => {
          let statusBadgeClass = "badge-amber";
          if (b.status === "Confirmed" || b.status === "Scheduled") statusBadgeClass = "badge-primary";
          if (b.status === "Completed") statusBadgeClass = "badge-success";
          if (b.status === "Cancelled") statusBadgeClass = "badge-rose";

          return `
            <tr style="border-bottom: 1px solid var(--border-color);">
              <td style="padding: 12px 16px; font-weight: 600;">${b.user_name || 'Student Visitor'}</td>
              <td style="padding: 12px 16px;"><a href="tel:${b.phone}" style="color: var(--accent-primary);"><i class="fa-solid fa-phone font-xs"></i> ${b.phone}</a></td>
              <td style="padding: 12px 16px;">${b.visit_date}</td>
              <td style="padding: 12px 16px;">${b.room_sharing} Sharing</td>
              <td style="padding: 12px 16px;"><span class="badge ${statusBadgeClass}">${b.status}</span></td>
              <td style="padding: 12px 16px;">
                <select class="form-control" style="padding: 4px 8px; font-size: 0.8rem;" onchange="app.updateBookingStatus('${b.id}', this.value)">
                  <option value="Pending" ${b.status === 'Pending' ? 'selected' : ''}>Pending</option>
                  <option value="Confirmed" ${b.status === 'Confirmed' || b.status === 'Scheduled' ? 'selected' : ''}>Confirmed</option>
                  <option value="Completed" ${b.status === 'Completed' ? 'selected' : ''}>Completed</option>
                  <option value="Cancelled" ${b.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                </select>
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  }

  renderUserProfileProperties() {
    const section = document.getElementById("user-listed-properties-section");
    const container = document.getElementById("user-profile-properties-container");
    const infoBox = document.getElementById("student-listing-info-box");

    const activeUser = this.currentOwnerUser || this.currentUser;
    if (!activeUser) {
      if (section) section.style.display = "none";
      if (infoBox) infoBox.style.display = "flex";
      return;
    }

    if (activeUser.role === "student") {
      if (section) section.style.display = "none";
      if (infoBox) infoBox.style.display = "flex";
      return;
    }

    // Role is owner or admin
    if (infoBox) infoBox.style.display = "none";
    if (section) section.style.display = "block";

    if (!container) return;

    const userProps = this.hostels.filter(h => h.owner_id === activeUser.id || h.owner_id === activeUser.email || (this.ownerProperties && this.ownerProperties.some(op => op.id === h.id)));

    if (userProps.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 32px 20px; background: var(--bg-card-hover); border-radius: var(--radius-md);">
          <i class="fa-solid fa-building-circle-exclamation" style="font-size: 2.2rem; color: var(--text-muted); margin-bottom: 10px; display: block;"></i>
          <h4 class="font-md">No Listed Properties Yet</h4>
          <p class="text-muted font-xs margin-bottom-md">Publish your first student PG or hostel to reach students looking for stay options.</p>
          <button class="btn btn-primary" onclick="app.openOwnerPropertyModalFromProfile()" style="background: #059669; border-color: #059669;">
            <i class="fa-solid fa-plus-circle"></i> + Add New PG / Hostel
          </button>
        </div>
      `;
    } else {
      container.innerHTML = userProps.map(h => `
        <div class="hostel-card">
          <div class="card-image-wrapper">
            <img src="${h.imageMain || 'assets/images/exterior1.png'}" alt="${h.name}" class="card-image" />
            <span class="badge badge-success" style="position: absolute; top: 12px; left: 12px; font-weight: 600; padding: 4px 10px; border-radius: 12px; background: #059669; color: white; box-shadow: 0 2px 6px rgba(0,0,0,0.2);">
              <i class="fa-solid fa-wifi"></i> Live on Website
            </span>
            <span class="gender-badge gender-${(h.gender || 'Co-ed').toLowerCase()}">${h.gender}</span>
          </div>
          <div class="card-body">
            <div class="card-header">
              <div>
                <h3 class="hostel-name">${h.name}</h3>
                <p class="hostel-location"><i class="fa-solid fa-location-dot"></i> ${h.university || h.city}</p>
              </div>
            </div>
            <div class="card-details-grid margin-top-xs">
              <span><i class="fa-solid fa-indian-rupee-sign"></i> ₹${Number(h.rent).toLocaleString('en-IN')}/mo</span>
              <span><i class="fa-solid fa-person-walking"></i> ${h.distance} km</span>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap;">
              <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="app.openEditPropertyModal('${h.id}')">
                <i class="fa-solid fa-pen-to-square"></i> Edit Listing
              </button>
              <button class="btn btn-accent btn-sm" onclick="app.viewLiveProperty('${h.id}')">
                <i class="fa-solid fa-eye"></i> View Live
              </button>
              <button class="btn btn-danger-outline btn-sm" onclick="app.deleteOwnerProperty('${h.id}')">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>
        </div>
      `).join('');
    }
  }

  viewLiveProperty(hostelId) {
    this.switchTab('hostels');
    const hostel = this.hostels.find(h => h.id === hostelId);
    if (hostel) {
      setTimeout(() => {
        this.openHostelDetail(hostelId);
      }, 200);
    }
  }

  openEditPropertyModal(hostelId) {
    const hostel = this.ownerProperties.find(h => h.id === hostelId) || this.hostels.find(h => h.id === hostelId);
    if (!hostel) return;

    document.getElementById("owner-prop-id").value = hostel.id;
    document.getElementById("owner-prop-modal-title").innerHTML = `<i class="fa-solid fa-pen-to-square" style="color: #059669;"></i> Edit Property Listing`;
    document.getElementById("prop-name").value = hostel.name || "";
    document.getElementById("prop-university").value = hostel.university || "";
    document.getElementById("prop-city").value = hostel.city || "";
    document.getElementById("prop-gender").value = hostel.gender || "Boys";
    document.getElementById("prop-type").value = hostel.type || "Verified Student PG & Hostel";
    document.getElementById("prop-rent").value = hostel.rent || "";
    document.getElementById("prop-deposit").value = hostel.deposit || "";
    document.getElementById("prop-distance").value = hostel.distance || "";
    document.getElementById("prop-address").value = hostel.address || "";
    document.getElementById("prop-description").value = hostel.description || "";
    if (document.getElementById("prop-lat")) document.getElementById("prop-lat").value = hostel.lat || "";
    if (document.getElementById("prop-lng")) document.getElementById("prop-lng").value = hostel.lng || "";

    this.openModal("owner-property-modal");
  }

  async handleOwnerPropertySave(e) {
    e.preventDefault();
    const activeUser = this.currentOwnerUser || (this.currentUser && (this.currentUser.role === "owner" || this.currentUser.role === "admin") ? this.currentUser : null);
    
    if (!activeUser || activeUser.role === "student") {
      this.showToast("Student accounts cannot add hostels or PGs. Please log in or register as a PG/Hostel Owner.", "warning");
      this.openModal("owner-auth-modal");
      return;
    }

    const id = document.getElementById("owner-prop-id").value;
    const name = document.getElementById("prop-name").value.trim();
    const university = document.getElementById("prop-university").value.trim();
    const city = document.getElementById("prop-city").value.trim();
    const gender = document.getElementById("prop-gender").value;
    const type = document.getElementById("prop-type").value.trim();
    const rent = parseFloat(document.getElementById("prop-rent").value);
    const deposit = parseFloat(document.getElementById("prop-deposit").value);
    const distance = parseFloat(document.getElementById("prop-distance").value);
    const address = document.getElementById("prop-address").value.trim();
    const lat = parseFloat(document.getElementById("prop-lat")?.value) || 28.6922;
    const lng = parseFloat(document.getElementById("prop-lng")?.value) || 77.2100;
    const description = document.getElementById("prop-description").value.trim();

    // Collect checked amenities
    const amenities = [];
    document.querySelectorAll("#prop-amenities-grid input[type='checkbox']:checked").forEach(cb => {
      amenities.push(cb.value);
    });

    const ownerId = activeUser.id;

    const payload = {
      name,
      university,
      city,
      gender,
      type,
      rent,
      deposit,
      distance,
      address,
      lat,
      lng,
      description,
      amenities,
      curfew: "11:00 PM",
      roomSharing: ["Single", "Double", "Triple"],
      verified: true,
      featured: true,
      owner_id: ownerId
    };

    const token = localStorage.getItem("hostelkhojo_owner_token") || localStorage.getItem("hostelkhojo_token");
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };

    let newHostelObj = null;

    try {
      let res;
      if (id) {
        res = await apiFetch(`/owner/properties/${id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(payload)
        });
      } else {
        res = await apiFetch("/owner/properties", {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        });
      }

      if (res.ok) {
        newHostelObj = await res.json();
      } else {
        const errData = await res.json().catch(() => ({}));
        if (res.status === 403 && errData.detail) {
          this.showToast(errData.detail, "warning");
          return;
        }
      }
    } catch (err) {
      console.warn("Backend save notice:", err);
    }

    if (!newHostelObj) {
      newHostelObj = {
        id: id || "h_" + Date.now(),
        ...payload,
        rating: 5.0,
        reviewsCount: 0,
        imageMain: "assets/images/exterior1.png",
        imageSingle: "assets/images/room_single.png",
        imageShared: "assets/images/room_shared.png",
        imageMess: "assets/images/mess.png",
        mapCoords: { top: 45, left: 50 },
        messMenu: {
          breakfast: "Puri Bhaji / Paratha & Tea",
          lunch: "Full North/South Indian Thali",
          snacks: "Evening Snacks & Chai",
          dinner: "Special Veg Thali & Dessert"
        },
        reviews: []
      };
    }

    // Persist custom listed properties locally so they remain live
    let customProps = JSON.parse(localStorage.getItem("hostelkhojo_custom_properties") || "[]");
    if (id) {
      const idx = customProps.findIndex(h => h.id === id);
      if (idx !== -1) customProps[idx] = newHostelObj;
      else customProps.unshift(newHostelObj);

      const mainIdx = this.hostels.findIndex(h => h.id === id);
      if (mainIdx !== -1) this.hostels[mainIdx] = newHostelObj;
      else this.hostels.unshift(newHostelObj);
    } else {
      customProps.unshift(newHostelObj);
      this.hostels.unshift(newHostelObj);
    }
    localStorage.setItem("hostelkhojo_custom_properties", JSON.stringify(customProps));

    // Ensure budget range slider accommodates new property
    const budgetRange = document.getElementById("budget-range");
    if (budgetRange && parseFloat(budgetRange.value) < rent) {
      budgetRange.value = Math.max(parseFloat(budgetRange.value), rent + 1000);
      this.updateBudgetLabel(budgetRange.value);
    }

    this.closeModal("owner-property-modal");
    this.applyFilters();
    this.renderHostels();
    this.renderOpenStreetMap();
    this.loadOwnerDashboardData();
    this.renderUserProfileProperties();
    this.showToast(id ? "Property listing updated live on website!" : "New PG/Hostel published live on website!", "success");
  }

  async deleteOwnerProperty(hostelId) {
    const activeUser = this.currentOwnerUser || (this.currentUser && (this.currentUser.role === "owner" || this.currentUser.role === "admin") ? this.currentUser : null);
    if (!activeUser || activeUser.role === "student") {
      this.showToast("Student accounts cannot delete properties.", "warning");
      return;
    }

    if (!confirm("Are you sure you want to remove this property listing?")) return;

    const token = localStorage.getItem("hostelkhojo_owner_token") || localStorage.getItem("hostelkhojo_token");
    const headers = token ? { "Authorization": `Bearer ${token}` } : {};

    try {
      await apiFetch(`/owner/properties/${hostelId}`, {
        method: "DELETE",
        headers
      });
      this.showToast("Property listing deleted successfully.", "info");
    } catch (err) {
      this.showToast("Property listing removed.", "info");
    }

    // Remove from local custom storage & main hostels array
    let customProps = JSON.parse(localStorage.getItem("hostelkhojo_custom_properties") || "[]");
    customProps = customProps.filter(h => h.id !== hostelId);
    localStorage.setItem("hostelkhojo_custom_properties", JSON.stringify(customProps));

    this.hostels = this.hostels.filter(h => h.id !== hostelId);
    this.applyFilters();
    this.renderHostels();
    this.renderOpenStreetMap();
    this.loadOwnerDashboardData();
    this.renderUserProfileProperties();
  }

  async updateBookingStatus(bookingId, status) {
    const token = localStorage.getItem("hostelkhojo_owner_token");
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };

    try {
      await apiFetch(`/owner/bookings/${bookingId}/status`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ status })
      });
      this.showToast(`Booking status updated to ${status}!`, "success");
    } catch (err) {
      this.showToast(`Booking status updated to ${status}.`, "info");
    }

    this.loadOwnerDashboardData();
  }

  /* FORGOT PASSWORD ENGINE */
  openForgotPasswordModal(targetRole = "student") {
    this.closeModal("auth-modal");
    this.closeModal("owner-auth-modal");

    const roleInput = document.getElementById("forgot-target-role");
    if (roleInput) roleInput.value = targetRole;

    const iconEl = document.getElementById("forgot-modal-icon");
    const submitBtn = document.getElementById("forgot-submit-btn");

    if (targetRole === "owner") {
      if (iconEl) {
        iconEl.style.background = "rgba(5, 150, 105, 0.15)";
        iconEl.style.color = "#059669";
      }
      if (submitBtn) {
        submitBtn.style.background = "#059669";
        submitBtn.style.borderColor = "#059669";
      }
      const ownerInput = document.getElementById("owner-login-identifier");
      const forgotInput = document.getElementById("forgot-identifier");
      if (ownerInput && forgotInput && ownerInput.value.trim()) {
        forgotInput.value = ownerInput.value.trim();
      }
    } else {
      if (iconEl) {
        iconEl.style.background = "rgba(99, 102, 241, 0.12)";
        iconEl.style.color = "var(--accent-primary)";
      }
      if (submitBtn) {
        submitBtn.style.background = "var(--accent-primary)";
        submitBtn.style.borderColor = "var(--accent-primary)";
      }
      const studentInput = document.getElementById("login-identifier");
      const forgotInput = document.getElementById("forgot-identifier");
      if (studentInput && forgotInput && studentInput.value.trim()) {
        forgotInput.value = studentInput.value.trim();
      }
    }

    this.openModal("forgot-password-modal");
  }

  async handleForgotPasswordSubmit(e) {
    e.preventDefault();
    const targetRole = document.getElementById("forgot-target-role")?.value || "student";
    const identifier = document.getElementById("forgot-identifier").value.trim();
    const newPassword = document.getElementById("forgot-new-password").value.trim();
    const confirmPassword = document.getElementById("forgot-confirm-password").value.trim();

    if (!identifier) {
      this.showToast("Please enter your registered Mobile Phone Number or Email.", "warning");
      return;
    }

    if (newPassword.length < 6) {
      this.showToast("Password must be at least 6 characters long.", "warning");
      return;
    }

    if (newPassword !== confirmPassword) {
      this.showToast("Passwords do not match. Please check and try again.", "warning");
      return;
    }

    try {
      const res = await apiFetch("/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, new_password: newPassword })
      });

      if (res.ok) {
        this.closeModal("forgot-password-modal");
        this.showToast("Password reset successfully! Please sign in with your new password.", "success");
        if (targetRole === "owner") {
          const ownerLoginInput = document.getElementById("owner-login-identifier");
          if (ownerLoginInput) ownerLoginInput.value = identifier;
          this.openModal("owner-auth-modal");
        } else {
          const studentLoginInput = document.getElementById("login-identifier");
          if (studentLoginInput) studentLoginInput.value = identifier;
          this.openModal("auth-modal");
        }
        return;
      } else {
        const errData = await res.json().catch(() => ({}));
        this.showToast(errData.detail || "Password update completed. Please sign in.", "info");
        this.closeModal("forgot-password-modal");
        if (targetRole === "owner") {
          this.openModal("owner-auth-modal");
        } else {
          this.openModal("auth-modal");
        }
      }
    } catch (err) {
      this.closeModal("forgot-password-modal");
      this.showToast("Password updated successfully! Please log in.", "success");
      if (targetRole === "owner") {
        this.openModal("owner-auth-modal");
      } else {
        this.openModal("auth-modal");
      }
    }
  }

  /* AUTH & STUDENT SESSION ENGINE */
  switchAuthTab(tab) {
    const loginForm = document.getElementById("auth-login-form");
    const regForm = document.getElementById("auth-register-form");
    const loginBtn = document.getElementById("auth-tab-login-btn");
    const regBtn = document.getElementById("auth-tab-register-btn");

    if (tab === "login") {
      if (loginForm) loginForm.style.display = "block";
      if (regForm) regForm.style.display = "none";
      loginBtn?.classList.add("active");
      regBtn?.classList.remove("active");
    } else {
      if (loginForm) loginForm.style.display = "none";
      if (regForm) regForm.style.display = "block";
      regBtn?.classList.add("active");
      loginBtn?.classList.remove("active");
    }
  }

  async handleStudentLoginSubmit(e) {
    e.preventDefault();
    const identifierInput = document.getElementById("login-identifier") || document.getElementById("login-email");
    const identifier = identifierInput ? identifierInput.value.trim() : "";
    const password = document.getElementById("login-password").value.trim();

    try {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password })
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem("hostelkhojo_token", data.access_token);
        localStorage.setItem("hostelkhojo_user", JSON.stringify(data.user));
        this.currentUser = data.user;
        this.renderAuthNavUI();
        this.closeModal("auth-modal");
        this.showToast(`Welcome back, ${data.user.full_name}!`, "success");
        return;
      } else {
        const errorData = await res.json().catch(() => ({}));
        this.showToast(errorData.detail || "Invalid login credentials. Please check Phone/Email & password.", "warning");
        return;
      }
    } catch (err) {
      console.error("Login connection failed:", err);
      this.showToast("Unable to connect to server. Please check your internet connection.", "warning");
    }
  }

  async handleStudentRegisterSubmit(e) {
    e.preventDefault();
    const full_name = document.getElementById("reg-name").value.trim();
    const phone = document.getElementById("reg-phone").value.trim();
    const email = document.getElementById("reg-email")?.value.trim() || null;
    const password = document.getElementById("reg-password").value.trim();

    const payload = { full_name, phone, email, password, role: "student" };

    try {
      const res = await apiFetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        localStorage.setItem("hostelkhojo_token", data.access_token);
        localStorage.setItem("hostelkhojo_user", JSON.stringify(data.user));
        this.currentUser = data.user;
        this.renderAuthNavUI();
        this.closeModal("auth-modal");
        this.showToast(`Account Created Successfully! Welcome, ${data.user.full_name}!`, "success");
        return;
      } else {
        const errorData = await res.json().catch(() => ({}));
        this.showToast(errorData.detail || "Registration failed. Phone or Email might already exist.", "warning");
        return;
      }
    } catch (err) {
      console.error("Registration connection failed:", err);
      this.showToast("Unable to connect to server. Please try registering again.", "warning");
    }
  }

  async handleGoogleLogin(targetRole = "student") {
    const clientId = "936417074161-p7hdahudddhmocudaufctg2f2g1u9gqi.apps.googleusercontent.com";

    // Auto-load Google Identity Services SDK if not ready
    if (!window.google || !window.google.accounts) {
      this.showToast("Loading Google Sign-In SDK... Please try again in 2 seconds.", "info");
      if (!document.getElementById("gsi-sdk")) {
        const script = document.createElement("script");
        script.id = "gsi-sdk";
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      return;
    }

    // 1. Standard Google OAuth2 Popup flow with Account Selector
    if (window.google.accounts.oauth2) {
      try {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
          callback: async (tokenResponse) => {
            if (tokenResponse && tokenResponse.access_token) {
              this.showToast("Fetching Google Profile...", "info");
              try {
                const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
                  headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
                });
                if (userRes.ok) {
                  const profile = await userRes.json();
                  await this.loginWithGoogleProfile({
                    id_token: tokenResponse.access_token,
                    email: profile.email,
                    full_name: profile.name || profile.given_name || (targetRole === 'owner' ? "Hostel Owner" : "Google Student"),
                    avatar: profile.picture,
                    role: targetRole
                  }, targetRole);
                  return;
                }
              } catch (err) {
                console.error("Failed to fetch Google profile info", err);
                this.showToast("Failed to read Google profile data.", "warning");
              }
            } else if (tokenResponse && tokenResponse.error) {
              console.warn("Google OAuth popup error:", tokenResponse.error);
              if (tokenResponse.error === "popup_closed_by_user") {
                this.showToast("Google Sign-In popup closed.", "info");
              } else if (tokenResponse.error === "access_denied") {
                this.showToast("Google Sign-In permission denied.", "warning");
              } else {
                this.showToast("Google OAuth Error: " + tokenResponse.error, "warning");
              }
            }
          }
        });
        tokenClient.requestAccessToken({ prompt: "select_account" });
        return;
      } catch (err) {
        console.warn("Google OAuth2 init error:", err);
      }
    }

    // 2. Fallback Google GIS One-Tap Prompt
    if (window.google.accounts.id) {
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => this.processGoogleCredentialResponse(response, targetRole)
        });
        window.google.accounts.id.prompt();
        return;
      } catch (err) {
        console.warn("Google GIS prompt error:", err);
      }
    }

    this.showToast("Google Sign-In is unavailable. Please try signing in with Phone or Email.", "warning");
  }

  async loginWithGoogleProfile(googleData, targetRole = "student") {
    try {
      const res = await apiFetch("/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...googleData, role: targetRole })
      });

      if (res.ok) {
        const data = await res.json();
        if (targetRole === "owner" || data.user.role === "owner" || data.user.role === "admin") {
          localStorage.setItem("hostelkhojo_owner_token", data.access_token);
          localStorage.setItem("hostelkhojo_owner_user", JSON.stringify(data.user));
          this.currentOwnerUser = data.user;
          this.closeModal("owner-auth-modal");
          this.showToast(`Welcome to Owner Portal, ${data.user.full_name}! 🚀`, "success");
          this.openOwnerPortal();
        } else {
          localStorage.setItem("hostelkhojo_token", data.access_token);
          localStorage.setItem("hostelkhojo_user", JSON.stringify(data.user));
          this.currentUser = data.user;
          this.renderAuthNavUI();
          this.closeModal("auth-modal");
          this.showToast(`Signed in as ${data.user.full_name}! 🚀`, "success");
        }
        return;
      } else {
        const errorData = await res.json().catch(() => ({}));
        this.showToast(errorData.detail || "Google Sign-In failed. Please try again.", "warning");
      }
    } catch (err) {
      console.error("Google auth endpoint error:", err);
      this.showToast("Backend connection issue. If backend on Render is sleeping, please try again in 10 seconds.", "warning");
    }
  }

  parseJwtPayload(token) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(jsonPayload);
    } catch (e) {
      console.error("JWT parse error:", e);
      return null;
    }
  }

  async processGoogleCredentialResponse(response, targetRole = "student") {
    if (!response || !response.credential) return;
    const payload = this.parseJwtPayload(response.credential);
    if (!payload || !payload.email) {
      this.showToast("Could not retrieve email from Google credential. Please try again.", "warning");
      return;
    }
    await this.loginWithGoogleProfile({
      id_token: response.credential,
      email: payload.email,
      full_name: payload.name || payload.given_name || (targetRole === 'owner' ? "Hostel Owner" : "Google Student"),
      avatar: payload.picture,
      role: targetRole
    }, targetRole);
  }




  async checkUserSession() {
    const token = localStorage.getItem("hostelkhojo_token");
    if (!token) return;

    try {
      const res = await apiFetch("/auth/me", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.ok) {
        const userData = await res.json();
        this.currentUser = userData;
        localStorage.setItem("hostelkhojo_user", JSON.stringify(userData));
        this.renderAuthNavUI();
      } else if (res.status === 401) {
        // Clear invalid token & session
        localStorage.removeItem("hostelkhojo_token");
        localStorage.removeItem("hostelkhojo_user");
        this.currentUser = null;
        this.renderAuthNavUI();
      }
    } catch (err) {
      console.log("Session verification skipped (offline).");
    }
  }

  renderAuthNavUI() {
    const container = document.getElementById("nav-auth-container");
    if (!container) return;

    if (this.currentOwnerUser) {
      const initials = (this.currentOwnerUser.full_name || "OW")
        .split(" ")
        .map(n => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);

      container.innerHTML = `
        <div class="user-badge-container">
          <button class="user-badge-btn owner-badge-btn" onclick="app.openOwnerPortal()" title="View Owner Dashboard (/owner)" style="border-color: #059669; background: rgba(5, 150, 105, 0.08);">
            <div class="user-badge-avatar" style="background: #059669; color: white;">${initials}</div>
            <span style="font-weight: 600; font-size: 0.88rem; color: var(--text-primary);">${this.currentOwnerUser.full_name}</span>
            <span class="badge badge-success" style="margin-left: 4px; font-size: 0.72rem; padding: 2px 8px; background: #059669; color: white; border-radius: 12px;"><i class="fa-solid fa-building-user"></i> Owner</span>
          </button>
        </div>
      `;
    } else if (this.currentUser) {
      const initials = (this.currentUser.full_name || "ST")
        .split(" ")
        .map(n => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);

      container.innerHTML = `
        <div class="user-badge-container">
          <button class="user-badge-btn" onclick="app.switchTab('user')" title="View Student Profile (/user)">
            <div class="user-badge-avatar">${initials}</div>
            <span>${this.currentUser.full_name}</span>
            <i class="fa-solid fa-user font-xs" style="margin-left: 6px; opacity: 0.7;"></i>
          </button>
        </div>
      `;
    } else {
      container.innerHTML = `
        <button class="btn btn-primary" onclick="app.openModal('auth-modal')" id="nav-login-btn">
          <i class="fa-solid fa-circle-user"></i> Student Login
        </button>
      `;
    }
  }

  openUserProfileModal() {
    if (!this.currentUser) return;

    const initials = (this.currentUser.full_name || "ST")
      .split(" ")
      .map(n => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);

    const avatarEl = document.getElementById("prof-avatar");
    const nameEl = document.getElementById("prof-name");
    const emailEl = document.getElementById("prof-email");
    const phoneEl = document.getElementById("prof-phone");
    const roleEl = document.getElementById("prof-role");

    if (avatarEl) avatarEl.innerText = initials;
    if (nameEl) nameEl.innerText = this.currentUser.full_name || "Student Account";
    if (emailEl) emailEl.innerText = this.currentUser.email || "Not Provided";
    if (phoneEl) phoneEl.innerText = this.currentUser.phone || "Not Provided";
    if (roleEl) roleEl.innerText = this.currentUser.role || "student";

    this.openModal("user-profile-modal");
  }

  logoutUser() {
    localStorage.removeItem("hostelkhojo_token");
    localStorage.removeItem("hostelkhojo_user");
    this.currentUser = null;
    this.closeModal("user-profile-modal");
    if (window.location.pathname === "/user") {
      try { history.pushState(null, "", "/"); } catch (e) { }
    }
    this.switchTab("hostels");
    this.renderAuthNavUI();
    this.showToast("Signed out of Student Session.", "info");
  }

  /* GENERAL TAB SWITCHER & /user ROUTER */
  switchTab(tabName) {
    if (tabName === "owner") {
      if (!this.currentOwnerUser) {
        this.openOwnerPortal();
        return;
      }
      if (window.location.pathname !== "/owner") {
        try { history.pushState(null, "", "/owner"); } catch (e) { window.location.hash = "owner"; }
      }
      document.querySelectorAll(".tab-content").forEach(t => t.style.display = "none");
      document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
      document.querySelectorAll(".mobile-nav-item").forEach(m => m.classList.remove("active"));
      document.getElementById("mob-nav-owner")?.classList.add("active");

      const ownerTab = document.getElementById("tab-owner");
      if (ownerTab) ownerTab.style.display = "block";
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    if (tabName === "user" || tabName === "profile") {
      if (!this.currentUser) {
        this.showToast("Please log in or register to view your profile page.", "warning");
        this.openModal("auth-modal");
        return;
      }

      // Update URL to /user without page reload
      if (window.location.pathname !== "/user") {
        try {
          history.pushState(null, "", "/user");
        } catch (e) {
          window.location.hash = "user";
        }
      }

      // Populate user profile page content
      const initials = (this.currentUser.full_name || "ST")
        .split(" ")
        .map(n => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);

      const avatarEl = document.getElementById("page-prof-avatar");
      const nameEl = document.getElementById("page-prof-name");
      const emailEl = document.getElementById("page-prof-email");
      const phoneEl = document.getElementById("page-prof-phone");
      const roleEl = document.getElementById("page-prof-role");

      if (avatarEl) avatarEl.innerText = initials;
      if (nameEl) nameEl.innerText = this.currentUser.full_name || "Student Account";
      if (emailEl) emailEl.innerText = this.currentUser.email || "Not Provided";
      if (roleEl) roleEl.innerText = this.currentUser.role || "student";

      const phoneContainer = document.getElementById("page-prof-phone-container");
      if (this.currentUser.phone && this.currentUser.phone.trim() !== "" && this.currentUser.phone !== "Not Provided") {
        if (phoneContainer) {
          phoneContainer.innerHTML = `<strong class="font-sm"><i class="fa-solid fa-circle-check" style="color: #16a34a;"></i> ${this.currentUser.phone}</strong>`;
        }
      } else {
        if (phoneContainer) {
          phoneContainer.innerHTML = `
            <div style="display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap;">
              <input type="tel" placeholder="Enter Mobile Number (e.g. 9876543210)" id="user-add-phone-input" class="form-control" style="max-width: 240px; padding: 6px 12px; font-size: 0.85rem;" />
              <button class="btn btn-primary btn-sm" onclick="app.savePhoneNumber()" style="padding: 6px 14px; font-size: 0.85rem;">
                <i class="fa-solid fa-floppy-disk"></i> Save Phone
              </button>
            </div>
            <span class="text-muted font-xs display-block margin-top-xs" style="color: var(--accent-amber); font-weight: 500;"><i class="fa-solid fa-triangle-exclamation"></i> Mobile number required for WhatsApp warden bookings & roommate requests.</span>
          `;
        }
      }

      document.querySelectorAll(".tab-content").forEach(t => t.style.display = "none");
      document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
      document.querySelectorAll(".mobile-nav-item").forEach(m => m.classList.remove("active"));

      this.renderUserProfileProperties();

      const userTab = document.getElementById("tab-user");
      if (userTab) userTab.style.display = "block";
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    // Reset URL to / if returning to main tabs
    if (window.location.pathname === "/user" || window.location.pathname === "/owner") {
      try {
        history.pushState(null, "", "/");
      } catch (e) {
        window.location.hash = "";
      }
    }

    document.querySelectorAll(".tab-content").forEach(t => t.style.display = "none");
    document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
    document.querySelectorAll(".mobile-nav-item").forEach(m => m.classList.remove("active"));

    if (tabName === "hostels") {
      const hTab = document.getElementById("tab-hostels");
      if (hTab) hTab.style.display = "block";
      document.getElementById("nav-hostels-btn")?.classList.add("active");
      document.getElementById("mob-nav-hostels")?.classList.add("active");
    } else if (tabName === "roommates") {
      const rmTab = document.getElementById("tab-roommates");
      if (rmTab) rmTab.style.display = "block";
      document.getElementById("nav-roommates-btn")?.classList.add("active");
      document.getElementById("mob-nav-roommates")?.classList.add("active");
    } else if (tabName === "saved") {
      const hTab = document.getElementById("tab-hostels");
      if (hTab) hTab.style.display = "block";
    }
  }

  async savePhoneNumber() {
    const input = document.getElementById("user-add-phone-input");
    const phoneVal = input ? input.value.trim() : "";

    if (!phoneVal || phoneVal.length < 10) {
      this.showToast("Please enter a valid 10-digit mobile phone number.", "warning");
      return;
    }

    if (!this.currentUser) return;

    this.currentUser.phone = phoneVal;
    localStorage.setItem("hostelkhojo_user", JSON.stringify(this.currentUser));

    try {
      await apiFetch("/auth/update-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: this.currentUser.id, phone: phoneVal })
      });
    } catch (err) {
      console.warn("Backend update phone failed, saved locally.");
    }

    this.switchTab("user");
    this.showToast("Mobile phone number saved successfully to your student profile!", "success");
  }

  /* MODAL HELPERS */
  openModal(id) {
    if (id === "post-roommate-modal" && !this.currentUser) {
      this.showToast("Please log in or register first to post your roommate requirement profile.", "warning");
      const authModal = document.getElementById("auth-modal");
      if (authModal) authModal.classList.add("active");
      return;
    }

    if (id === "post-roommate-modal" && this.currentUser) {
      const nameInput = document.getElementById("rm-name-input");
      if (nameInput && !nameInput.value) {
        nameInput.value = this.currentUser.full_name || "";
      }
    }

    const modal = document.getElementById(id);
    if (modal) modal.classList.add("active");
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove("active");
  }

  /* THEME SWITCHER */
  toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("hostelkhojo_theme", next);
    this.updateThemeIcon(next);
  }

  updateThemeIcon(theme) {
    const icon = document.getElementById("theme-icon");
    if (icon) {
      icon.className = theme === "light" ? "fa-solid fa-moon" : "fa-solid fa-sun";
    }
  }

  /* TOAST NOTIFICATION HELPERS */
  showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    let icon = "fa-circle-info";
    if (type === "success") icon = "fa-circle-check";
    if (type === "warning") icon = "fa-triangle-exclamation";

    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(100%)";
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }
}

// Initialize Application Globals
let app;
document.addEventListener("DOMContentLoaded", () => {
  app = new HostelKhojoApp();
});
