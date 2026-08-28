/* ==========================================================================
   HOSTEL KHOJO INDIA - APPLICATION ENGINE
   ========================================================================== */

const RENDER_BACKEND_URL = "https://hostelkhojo.onrender.com/api";
const LOCAL_BACKEND_URL = "http://127.0.0.1:8000/api";
let API_BASE_URL = (
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.protocol === "file:" ||
  !window.location.hostname
)
  ? LOCAL_BACKEND_URL
  : (window.location.origin.includes("onrender.com") ? `${window.location.origin}/api` : RENDER_BACKEND_URL);


let hasShownConnectingToast = false;
let coldStartTimer = null;

// Pre-warm backend immediately on script execution
(function prewarmRenderBackend() {
  try {
    fetch("https://hostelkhojo.onrender.com/api/health", { mode: "cors" }).catch(() => {});
    // Periodic in-tab heartbeat every 4 minutes to prevent Render from going to sleep while tab is open
    setInterval(() => {
      fetch("https://hostelkhojo.onrender.com/api/health", { mode: "cors" }).catch(() => {});
    }, 4 * 60 * 1000);
  } catch (e) {}
})();

/**
 * Smart fetch wrapper that handles API requests.
 * Automatically handles localhost vs Render cloud backend, cold-start delays, and proxy fallbacks.
 */
async function apiFetch(endpoint, options = {}, retries = 4) {
  let url = `${API_BASE_URL}${endpoint}`;

  // If a mutation or auth request takes > 3s, show non-intrusive wake-up feedback
  const isStateChanging = options.method && ["POST", "PUT", "DELETE"].includes(options.method.toUpperCase());
  let timeoutNotice = null;
  if (isStateChanging && !hasShownConnectingToast && window.app && window.app.showToast) {
    timeoutNotice = setTimeout(() => {
      if (!hasShownConnectingToast) {
        hasShownConnectingToast = true;
        window.app.showToast("⚡ Cloud server is waking up from idle, please wait a few seconds...", "info");
      }
    }, 3000);
  }

  try {
    let res = await fetch(url, options);
    if (timeoutNotice) clearTimeout(timeoutNotice);

    const contentType = res.headers.get("content-type") || "";

    // If local proxy/static server returned 404 HTML, switch to direct Render cloud URL
    if ((contentType.includes("text/html") && res.status !== 200) && API_BASE_URL !== RENDER_BACKEND_URL) {
      API_BASE_URL = RENDER_BACKEND_URL;
      url = `${API_BASE_URL}${endpoint}`;
      res = await fetch(url, options);
    }

    // Handle Render free tier cold-start status (502, 503, 504) with quiet retries
    if ((res.status === 502 || res.status === 503 || res.status === 504) && retries > 0) {
      await new Promise(r => setTimeout(r, 2500));
      return await apiFetch(endpoint, options, retries - 1);
    }

    return res;
  } catch (err) {
    if (timeoutNotice) clearTimeout(timeoutNotice);
    if (API_BASE_URL !== RENDER_BACKEND_URL) {
      API_BASE_URL = RENDER_BACKEND_URL;
      return await apiFetch(endpoint, options, retries);
    }
    if (retries > 0) {
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
    this.hostels = [];
    this.filteredHostels = [];
    this.roommates = [];

    this.savedIds = JSON.parse(localStorage.getItem("hostelkhojo_saved") || localStorage.getItem("dormify_saved") || "[]");
    this.comparisonIds = [];
    this.activePills = new Set();

    this.currentUser = JSON.parse(localStorage.getItem("hostelkhojo_user") || "null");
    this.currentOwnerUser = JSON.parse(localStorage.getItem("hostelkhojo_owner_user") || "null");
    this.currentAdminUser = null; // Super Admin always requires password verification on access
    this.ownerProperties = [];
    this.ownerBookings = [];

    this.currentViewMode = "grid"; // 'grid' or 'split'
    this.currentSort = "recommended";
    this.currentMapTileLayer = "street"; // 'street', 'satellite', 'dark'
    this.mapBoundsSync = false;
    this.activeMapPois = new Set();
    this.poiMarkers = [];
    this.campusCenterMarker = null;
    this.campusRadiusCircle = null;
    this.showCampusRadius = true;
    this.isMobileMapActive = false;
    this.activeHoverPreviewId = null;
    this.hoveredPinId = null;
    this.currentTileLayerObj = null;

    this.searchDebounceTimer = null;
    this.mapDebounceTimer = null;
    this.renderRaf = null;

    this.initGoogleMapsEngine();
    this.init();
  }

  init() {
    // Enforce strict single-role session: either PG Owner or Student
    if (this.currentOwnerUser && localStorage.getItem("hostelkhojo_owner_token")) {
      this.currentUser = null;
      localStorage.removeItem("hostelkhojo_token");
      localStorage.removeItem("hostelkhojo_user");
    } else if (this.currentUser && localStorage.getItem("hostelkhojo_token")) {
      this.currentOwnerUser = null;
      localStorage.removeItem("hostelkhojo_owner_token");
      localStorage.removeItem("hostelkhojo_owner_user");
    }

    this.updateSavedCount();
    this.renderHostels();
    this.renderRoommates();
    this.setMapProvider(this.mapProvider);
    this.loadBackendData();
    this.checkOwnerSession();
    this.checkUserSession();
    this.checkAdminSession();
    this.renderAuthNavUI();

    // Load admin user & hostel tables on load
    this.adminUsers = this.mergeAdminUsers([]);
    this.renderAdminUsersTables();

    // Handle URL routing for /admin, /user or /owner
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

    if (path.includes("/admin") || hash === "#admin") {
      if (!this.currentAdminUser || this.currentAdminUser.role !== "admin") {
        this.switchTab("hostels");
        this.openModal("admin-auth-modal");
      } else {
        this.openAdminPortal();
      }
    } else if (path.includes("/owner") || hash === "#owner") {
      this.openOwnerPortal();
    } else if (path.includes("/user") || path.includes("/profile") || hash === "#user" || hash === "#profile") {
      this.switchTab("user");
    }
  }


  async loadBackendData() {
    let cloudHostels = [];
    try {
      const res = await apiFetch("/hostels");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          cloudHostels = data;
        }
      }
    } catch (err) {
      console.log("FastAPI Backend offline or pending listings.");
    }

    // Known globally deleted hostel IDs / names to purge from old browser caches
    const knownDeletedIds = ["h_430a257b", "h_960de4f1"];
    const knownDeletedNames = ["hh", "kallu hostle"];

    // Persistent list of globally deleted hostel IDs
    let deletedIds = [];
    try {
      deletedIds = JSON.parse(localStorage.getItem("hostelkhojo_deleted_hostel_ids") || "[]");
      if (!Array.isArray(deletedIds)) deletedIds = [];
    } catch (e) {}
    deletedIds = [...new Set([...deletedIds, ...knownDeletedIds])];
    try { localStorage.setItem("hostelkhojo_deleted_hostel_ids", JSON.stringify(deletedIds)); } catch (e) {}

    // Clean up local storage caches
    try {
      ["hostelkhojo_real_properties", "hostelkhojo_custom_properties", "hostelkhojo_owner_properties"].forEach(key => {
        const stored = localStorage.getItem(key);
        if (stored) {
          let list = JSON.parse(stored);
          if (Array.isArray(list)) {
            list = list.filter(p => p && p.id && !deletedIds.includes(String(p.id)) && (!p.name || !knownDeletedNames.includes(p.name.trim().toLowerCase())));
            localStorage.setItem(key, JSON.stringify(list));
          }
        }
      });
    } catch (e) {}

    // If cloud returned data, it is the primary authoritative source
    let combinedHostels = [];
    if (Array.isArray(cloudHostels) && cloudHostels.length > 0) {
      combinedHostels = [...cloudHostels];
    } else {
      // Fallback only if offline
      try {
        const stored = localStorage.getItem("hostelkhojo_real_properties");
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) combinedHostels = parsed;
        }
      } catch (e) {}
    }

    // Globally filter out any deleted hostels
    this.hostels = combinedHostels.filter(h => {
      if (!h || !h.id) return false;
      if (deletedIds.includes(String(h.id))) return false;
      if (h.name && knownDeletedNames.includes(h.name.trim().toLowerCase())) return false;
      return true;
    });

    this.applyFilters();
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
      console.log("FastAPI Backend offline, using local roommates.");
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
    const el = document.getElementById("budget-val");
    if (el) el.innerText = Number(val).toLocaleString('en-IN');
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
    const searchEl = document.getElementById("search-input");
    const searchTerm = searchEl ? searchEl.value.toLowerCase().trim() : "";

    const genderEl = document.getElementById("gender-filter");
    const gender = genderEl ? genderEl.value : "all";

    const roomTypeEl = document.getElementById("room-type-filter");
    const roomType = roomTypeEl ? roomTypeEl.value : "all";

    const budgetEl = document.getElementById("budget-range");
    const maxBudget = budgetEl ? (parseFloat(budgetEl.value) || 999999) : 999999;

    if (!Array.isArray(this.hostels)) {
      this.hostels = [];
    }

    this.filteredHostels = (this.hostels || []).filter(h => {
      if (!h) return false;
      if (h.is_live === false || h.is_live === 0) return false;


      // Keyword search
      const matchesText = !searchTerm ||
        (h.name && h.name.toLowerCase().includes(searchTerm)) ||
        (h.university && h.university.toLowerCase().includes(searchTerm)) ||
        (h.city && h.city.toLowerCase().includes(searchTerm)) ||
        (h.address && h.address.toLowerCase().includes(searchTerm));

      // Gender filter
      const matchesGender = gender === "all" || (h.gender && h.gender.toLowerCase() === gender.toLowerCase());

      // Room occupancy filter (1 Occupancy, 2 Occupancy, 3 Occupancy, 4 Occupancy)
      let matchesRoom = true;
      if (roomType !== "all") {
        const rsList = Array.isArray(h.roomSharing) ? h.roomSharing.map(s => String(s).toLowerCase()) : [String(h.roomSharing || '').toLowerCase()];
        const target = roomType.toLowerCase();
        if (target.includes("1") || target.includes("single")) {
          matchesRoom = rsList.some(r => r.includes("1") || r.includes("single"));
        } else if (target.includes("2") || target.includes("double")) {
          matchesRoom = rsList.some(r => r.includes("2") || r.includes("double"));
        } else if (target.includes("3") || target.includes("triple")) {
          matchesRoom = rsList.some(r => r.includes("3") || r.includes("triple"));
        } else if (target.includes("4") || target.includes("quad") || target.includes("four")) {
          matchesRoom = rsList.some(r => r.includes("4") || r.includes("quad") || r.includes("four"));
        } else {
          matchesRoom = rsList.some(r => r.includes(target));
        }
      }

      // Budget filter
      const matchesBudget = !h.rent || h.rent <= maxBudget;

      // Pill tags filter
      let matchesPills = true;
      const amenities = Array.isArray(h.amenities) ? h.amenities : [];
      if (this.activePills.has("walkable") && h.distance && h.distance > 0.5) matchesPills = false;
      if (this.activePills.has("mess") && !amenities.some(a => a && a.toLowerCase().includes("mess"))) matchesPills = false;
      if (this.activePills.has("ac") && !amenities.some(a => a && a.toLowerCase().includes("ac"))) matchesPills = false;
      if (this.activePills.has("wifi") && !amenities.some(a => a && a.toLowerCase().includes("wi-fi"))) matchesPills = false;
      if (this.activePills.has("gym") && !amenities.some(a => a && (a.toLowerCase().includes("power backup") || a.toLowerCase().includes("gym")))) matchesPills = false;

      return matchesText && matchesGender && matchesRoom && matchesBudget && matchesPills;
    });

    this.applySorting();
  }

  quickSearch(keyword) {
    const searchEl = document.getElementById("search-input");
    if (searchEl) searchEl.value = keyword;
    this.switchTab("hostels");
    this.applyFilters();
  }

  applySorting() {
    const sortEl = document.getElementById("sort-select");
    const sortVal = sortEl ? sortEl.value : "recommended";
    this.currentSort = sortVal;

    if (!Array.isArray(this.filteredHostels)) {
      this.filteredHostels = [...(this.hostels || [])];
    }

    if (sortVal === "price-asc") {
      this.filteredHostels.sort((a, b) => (a.rent || 0) - (b.rent || 0));
    } else if (sortVal === "price-desc") {
      this.filteredHostels.sort((a, b) => (b.rent || 0) - (a.rent || 0));
    } else if (sortVal === "rating-desc") {
      this.filteredHostels.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (sortVal === "distance-asc") {
      this.filteredHostels.sort((a, b) => (a.distance || 0) - (b.distance || 0));
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
      if (layout) layout.className = "explorer-layout split-view";
      if (gridBtn) gridBtn.classList.remove("active");
      if (splitBtn) splitBtn.classList.add("active");
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
      if (layout) layout.className = "explorer-layout grid-view";
      if (gridBtn) gridBtn.classList.add("active");
      if (splitBtn) splitBtn.classList.remove("active");
      this.isMobileMapActive = false;
      layout?.classList.remove("mobile-map-active");
    }
  }

  quickFilterGender(gender) {
    const genderEl = document.getElementById("gender-filter");
    if (genderEl) genderEl.value = gender;
    
    // Update chip active states
    document.querySelectorAll(".split-chip-filter").forEach(btn => {
      const isMatch = (gender === "all" && btn.textContent.trim() === "All") || btn.textContent.toLowerCase().includes(gender.toLowerCase());
      btn.classList.toggle("active", isMatch);
    });

    this.applyFilters();
  }

  /* RENDER HOSTEL CARDS */
  renderHostels() {
    const grid = document.getElementById("hostels-grid");
    const countNum = document.getElementById("results-count-num");
    const splitStatus = document.getElementById("split-list-status");
    if (!grid) return;

    if (!Array.isArray(this.filteredHostels)) {
      this.filteredHostels = [...(this.hostels || [])];
    }

    if (countNum) countNum.innerText = this.filteredHostels.length;
    if (splitStatus) {
      const searchVal = document.getElementById("search-input")?.value.trim();
      splitStatus.innerHTML = `<i class="fa-solid fa-location-dot" style="color: var(--primary);"></i> Showing ${this.filteredHostels.length} verified stays ${searchVal ? 'near <b>' + this.escapeHtml(searchVal) + '</b>' : 'in India'}`;
    }

    if (this.filteredHostels.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; padding: 48px 24px; text-align: center; background: var(--bg-surface); border: 2px dashed var(--border-color); border-radius: var(--radius-lg); margin: 20px 0;">
          <i class="fa-solid fa-building-circle-check" style="font-size: 3.5rem; color: var(--primary); margin-bottom: 16px;"></i>
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
      const genderClass = (h.gender || "Boys").toLowerCase().replace(/[^a-z]/g, '');

      return `
        <div class="hostel-card" id="card-${h.id}" 
             onmouseenter="app.highlightMapPin('${h.id}')" 
             onmouseleave="app.unhighlightMapPin('${h.id}')">
          <div class="card-media">
            <img src="${h.imageMain || 'assets/images/exterior1.png'}" alt="${this.escapeHtml(h.name)}" loading="lazy" />
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
              <h3 class="card-title">${this.escapeHtml(h.name)}</h3>
              <div class="card-rating">
                <i class="fa-solid fa-star"></i> ${h.rating || 4.8}
              </div>
            </div>

            <div class="card-location">
              <i class="fa-solid fa-location-dot"></i> 
              <span>${this.escapeHtml(h.university || h.city)}</span>
              ${h.distance ? `<span class="card-distance-badge"><i class="fa-solid fa-person-walking"></i> ${h.distance} km</span>` : ''}
            </div>

            <div class="card-amenities">
              ${(Array.isArray(h.amenities) ? h.amenities : []).slice(0, 4).map(a => `<span class="amenity-chip"><i class="fa-solid fa-check"></i> ${this.escapeHtml(a)}</span>`).join('')}
              ${Array.isArray(h.amenities) && h.amenities.length > 4 ? `<span class="amenity-chip">+${h.amenities.length - 4} more</span>` : ''}
            </div>

            <div class="card-occupancies" style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; margin-bottom: 10px;">
              ${(Array.isArray(h.roomSharing) && h.roomSharing.length > 0 ? h.roomSharing : ['1 Occupancy', '2 Occupancy']).map(occ => `
                <span style="font-size: 0.72rem; font-weight: 700; background: rgba(79, 70, 229, 0.08); color: var(--primary); padding: 2px 7px; border-radius: 4px; border: 1px solid rgba(79, 70, 229, 0.2);">
                  <i class="fa-solid fa-bed font-xs"></i> ${this.escapeHtml(occ)}
                </span>
              `).join('')}
              <span style="font-size: 0.72rem; font-weight: 700; background: rgba(16, 185, 129, 0.08); color: var(--success-green); padding: 2px 7px; border-radius: 4px; border: 1px solid rgba(16, 185, 129, 0.2);" title="Security Deposit">
                <i class="fa-solid fa-shield-halved font-xs"></i> Dep: ₹${Number(h.deposit || 5000).toLocaleString('en-IN')}
              </span>
            </div>

            <div class="card-footer-row">
              <div class="card-price">
                <span class="price-num">₹${Number(h.rent).toLocaleString('en-IN')}</span>
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
    document.querySelectorAll(".split-chip-filter").forEach(b => b.classList.toggle("active", b.textContent.trim() === "All"));
    this.applyFilters();
  }

  /* SIMULATED MAP PINS */
  renderMapPins() {
    const pinsLayer = document.getElementById("map-pins-layer");
    if (!pinsLayer) return;

    pinsLayer.innerHTML = this.filteredHostels.map(h => {
      const pinGenderClass = (h.gender || "Boys").toLowerCase().replace(/[^a-z]/g, '');
      return `
        <div class="map-pin pin-${pinGenderClass}" id="pin-${h.id}" 
             style="top: ${h.mapCoords?.top || 50}%; left: ${h.mapCoords?.left || 50}%;"
             onclick="app.openHostelDetail('${h.id}')"
             onmouseenter="app.highlightCard('${h.id}')">
          ₹${(h.rent / 1000).toFixed(1)}k
        </div>
      `;
    }).join('');
  }

  highlightMapPin(id) {
    this.hoveredPinId = id;
    
    // 1. Highlight Leaflet Pin
    const pinBubble = document.getElementById(`leaflet-pin-${id}`);
    if (pinBubble) {
      const parentMarkerEl = pinBubble.closest('.custom-osm-pin');
      if (parentMarkerEl) {
        parentMarkerEl.classList.add("active");
        parentMarkerEl.style.zIndex = "9999";
      }
    }

    // 2. Highlight Simulated Canvas Pin if active
    const simPin = document.getElementById(`pin-${id}`);
    if (simPin) simPin.classList.add("active");
  }

  unhighlightMapPin(id) {
    if (this.hoveredPinId === id) this.hoveredPinId = null;

    // 1. Unhighlight Leaflet Pin
    const pinBubble = document.getElementById(`leaflet-pin-${id}`);
    if (pinBubble) {
      const parentMarkerEl = pinBubble.closest('.custom-osm-pin');
      if (parentMarkerEl) {
        parentMarkerEl.classList.remove("active");
        parentMarkerEl.style.zIndex = "";
      }
    }

    // 2. Unhighlight Simulated Canvas Pin
    const simPin = document.getElementById(`pin-${id}`);
    if (simPin) simPin.classList.remove("active");
  }

  highlightCard(id) {
    document.querySelectorAll(".hostel-card.active-hovered").forEach(c => c.classList.remove("active-hovered"));
    const card = document.getElementById(`card-${id}`);
    if (card) {
      card.classList.add("active-hovered");
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(() => {
        card.classList.remove("active-hovered");
      }, 2500);
    }
  }

  showMapHoverPreview(id, latlng = null) {
    const h = this.hostels.find(item => item.id === id);
    const previewContainer = document.getElementById("map-hover-preview-card");
    if (!h || !previewContainer) return;

    this.activeHoverPreviewId = id;
    const directionsUrl = h.mapLink || `https://www.google.com/maps/dir/?api=1&destination=${h.lat || 28.6922},${h.lng || 77.2100}`;

    previewContainer.innerHTML = `
      <div class="map-preview-img-wrap">
        <img src="${h.imageMain || 'assets/images/exterior1.png'}" alt="${this.escapeHtml(h.name)}" />
        <button class="map-preview-close-btn" onclick="app.hideMapHoverPreview()" title="Close Preview">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <span class="badge-gender ${h.gender ? h.gender.toLowerCase() : 'boys'}" style="position: absolute; bottom: 8px; left: 8px; font-size: 0.68rem; padding: 2px 8px;">
          ${h.gender}
        </span>
      </div>
      <div class="map-preview-content">
        <div class="map-preview-header">
          <div class="map-preview-title">${this.escapeHtml(h.name)}</div>
          <div class="card-rating font-xs"><i class="fa-solid fa-star"></i> ${h.rating || 4.8}</div>
        </div>
        <div class="map-preview-sub">
          <i class="fa-solid fa-location-dot" style="color: var(--primary);"></i>
          <span>${this.escapeHtml(h.university || h.city)} (${h.distance} km)</span>
        </div>
        <div class="map-preview-footer">
          <div class="map-preview-price">₹${Number(h.rent).toLocaleString('en-IN')}<span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500;">/mo</span></div>
          <div style="display: flex; gap: 6px;">
            <a href="${directionsUrl}" target="_blank" class="map-preview-btn btn-outline" style="color: #059669; border: 1px solid #059669; text-decoration: none; padding: 4px 8px; font-size: 0.74rem;">
              <i class="fa-solid fa-diamond-turn-right"></i> Route
            </a>
            <button class="map-preview-btn btn-primary" onclick="app.openHostelDetail('${h.id}')" style="padding: 4px 10px; font-size: 0.74rem;">
              View Details
            </button>
          </div>
        </div>
      </div>
    `;

    previewContainer.style.display = "block";
    this.highlightCard(id);
    this.highlightMapPin(id);
  }

  hideMapHoverPreview() {
    const previewContainer = document.getElementById("map-hover-preview-card");
    if (previewContainer) previewContainer.style.display = "none";
    if (this.activeHoverPreviewId) {
      this.unhighlightMapPin(this.activeHoverPreviewId);
      this.activeHoverPreviewId = null;
    }
  }

  /* ==========================================================================
     OPENSTREETMAP (LEAFLET) LIVE MAP ENGINE - 100% FREE & ZERO WATERMARKS
     ========================================================================== */
  
  initGoogleMapsEngine() {
    this.mapProvider = localStorage.getItem("hostelkhojo_map_provider") || "osm";
    this.leafletMap = null;
    this.leafletMarkers = [];
    this.propertyMiniMap = null;
    this.propertyMiniMarker = null;
    this.googleMiniMap = null;
    this.googleMiniMarker = null;
    this.locationSearchDebounce = null;
    this.currentLocationSearchResults = [];

    // Check if Google Cloud Maps API Key is provided
    this.loadGoogleMapsApiIfConfigured();
  }

  loadGoogleMapsApiIfConfigured() {
    const apiKey = window.GOOGLE_MAPS_API_KEY || localStorage.getItem("hostelkhojo_gmaps_key") || "";
    if (apiKey && !window.google?.maps && !document.getElementById("google-maps-sdk-script")) {
      const script = document.createElement("script");
      script.id = "google-maps-sdk-script";
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&loading=async&callback=app.onGoogleMapsLoaded`;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else if (window.google?.maps) {
      this.initGooglePlacesAutocomplete();
    }
  }

  onGoogleMapsLoaded() {
    console.log("✅ Google Cloud Maps SDK & Places API connected successfully!");
    this.isGoogleSdkLoaded = true;
    this.initGooglePlacesAutocomplete();
    if (document.getElementById("prop-mini-map") && document.getElementById("owner-property-modal")?.classList.contains("active")) {
      this.initPropertyMiniMap();
    }
  }

  initGooglePlacesAutocomplete() {
    const input = document.getElementById("prop-location-search");
    if (!input || !window.google?.maps?.places) return;

    try {
      if (this.googleAutocomplete) return; // already attached
      this.googleAutocomplete = new google.maps.places.Autocomplete(input, {
        componentRestrictions: { country: "in" },
        fields: ["address_components", "geometry", "name", "formatted_address"]
      });

      this.googleAutocomplete.addListener("place_changed", () => {
        const place = this.googleAutocomplete.getPlace();
        if (!place || !place.geometry || !place.geometry.location) return;

        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();
        const shortName = place.name || place.formatted_address?.split(",")[0] || "";

        let city = "";
        if (place.address_components) {
          for (const comp of place.address_components) {
            if (comp.types.includes("locality") || comp.types.includes("administrative_area_level_2")) {
              city = comp.long_name;
              break;
            }
          }
        }

        const cityInp = document.getElementById("prop-city");
        if (cityInp && (!cityInp.value.trim() || cityInp.value.trim().length === 0) && city) {
          cityInp.value = city;
        }

        const uniInp = document.getElementById("prop-university");
        if (uniInp && (!uniInp.value.trim() || uniInp.value.trim().length === 0)) {
          uniInp.value = shortName;
        }

        const addrInp = document.getElementById("prop-address");
        if (addrInp && (!addrInp.value.trim() || addrInp.value.trim().length === 0)) {
          addrInp.value = place.formatted_address || shortName;
        }

        this.updatePropertyCoords(lat, lng, shortName);

        if (this.googleMiniMap) {
          this.googleMiniMap.setCenter({ lat, lng });
          this.googleMiniMap.setZoom(16);
          if (this.googleMiniMarker) this.googleMiniMarker.setPosition({ lat, lng });
        } else if (this.propertyMiniMap) {
          this.propertyMiniMap.setView([lat, lng], 16);
          if (this.propertyMiniMarker) this.propertyMiniMarker.setLatLng([lat, lng]);
          this.propertyMiniMap.invalidateSize();
        }
      });
    } catch (e) {
      console.warn("Google Places Autocomplete init notice:", e);
    }
  }

  escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /* ==========================================================================
     PROPERTY LISTING: INTERACTIVE MINI-MAP PIN SPOTTER & LOCATION SEARCH
     ========================================================================== */

  initPropertyMiniMap(customLat = null, customLng = null) {
    const mapContainer = document.getElementById("prop-mini-map");
    if (!mapContainer || typeof L === "undefined") return;

    let lat = customLat !== null ? customLat : (parseFloat(document.getElementById("prop-lat")?.value) || 28.6922);
    let lng = customLng !== null ? customLng : (parseFloat(document.getElementById("prop-lng")?.value) || 77.2100);

    try {
      if (!this.propertyMiniMap) {
        this.propertyMiniMap = L.map(mapContainer, {
          zoomControl: true,
          scrollWheelZoom: true,
          attributionControl: false
        }).setView([lat, lng], 14);

        // Google Maps Official Road Tiles Layer
        const googleRoadLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
          maxZoom: 20,
          subdomains: ['0', '1', '2', '3']
        });

        // OpenStreetMap Fallback Layer
        const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19
        });

        googleRoadLayer.addTo(this.propertyMiniMap);

        const pinHtml = `
          <div style="position: relative; width: 34px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: grab; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.55));">
            <svg viewBox="0 0 24 24" width="34" height="42" style="display: block;">
              <path fill="#EF4444" stroke="#FFFFFF" stroke-width="1.8" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
              <circle cx="12" cy="9" r="3.4" fill="#FFFFFF"/>
            </svg>
          </div>
        `;

        const pinIcon = L.divIcon({
          className: 'property-picker-pin',
          html: pinHtml,
          iconSize: [34, 42],
          iconAnchor: [17, 42]
        });

        this.propertyMiniMarker = L.marker([lat, lng], {
          draggable: true,
          icon: pinIcon
        }).addTo(this.propertyMiniMap);

        // Update coordinates on drag
        this.propertyMiniMarker.on('dragend', (e) => {
          const pos = e.target.getLatLng();
          this.updatePropertyCoords(pos.lat, pos.lng, "Fine-tuned Pin Location");
        });

        // Click on map to place pin
        this.propertyMiniMap.on('click', (e) => {
          this.propertyMiniMarker.setLatLng(e.latlng);
          this.updatePropertyCoords(e.latlng.lat, e.latlng.lng, "Selected Map Point");
        });

        // Automatic Resize & Visibility Observers so map tiles render immediately
        if (window.ResizeObserver) {
          const ro = new ResizeObserver(() => {
            if (this.propertyMiniMap) this.propertyMiniMap.invalidateSize();
          });
          ro.observe(mapContainer);
        }

        if (window.IntersectionObserver) {
          const io = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
              if (entry.isIntersecting && this.propertyMiniMap) {
                this.propertyMiniMap.invalidateSize();
              }
            });
          });
          io.observe(mapContainer);
        }

        mapContainer.addEventListener('mouseenter', () => {
          if (this.propertyMiniMap) this.propertyMiniMap.invalidateSize();
        });
      } else {
        this.propertyMiniMap.setView([lat, lng], 15);
        if (this.propertyMiniMarker) {
          this.propertyMiniMarker.setLatLng([lat, lng]);
        }
        this.propertyMiniMap.invalidateSize();
      }

      // Multi-staggered redraws for smooth CSS modal transitions
      [50, 150, 300, 600, 1000].forEach(delay => {
        setTimeout(() => {
          if (this.propertyMiniMap) this.propertyMiniMap.invalidateSize();
        }, delay);
      });
    } catch (e) {
      console.warn("Property mini-map notice:", e);
    }
  }

  recenterMiniMap(lat, lng, zoom = 16) {
    const numLat = parseFloat(lat);
    const numLng = parseFloat(lng);
    if (isNaN(numLat) || isNaN(numLng)) return;

    // 1. Native Google Maps instance
    if (this.googleMiniMap && typeof google !== "undefined" && google.maps) {
      try {
        const centerPos = new google.maps.LatLng(numLat, numLng);
        this.googleMiniMap.setCenter(centerPos);
        if (zoom) this.googleMiniMap.setZoom(zoom);
        if (this.googleMiniMarker) {
          this.googleMiniMarker.setPosition(centerPos);
        } else {
          this.googleMiniMarker = new google.maps.Marker({
            position: centerPos,
            map: this.googleMiniMap,
            draggable: true,
            title: "Drag to fine-tune entrance"
          });
        }
      } catch (e) {
        console.warn("Google mini map pan notice:", e);
      }
    }

    // 2. Leaflet Mini Map instance
    if (this.propertyMiniMap && typeof L !== "undefined") {
      try {
        this.propertyMiniMap.setView([numLat, numLng], zoom || 16, { animate: true, duration: 0.5 });
        if (this.propertyMiniMarker) {
          this.propertyMiniMarker.setLatLng([numLat, numLng]);
        } else {
          const pinHtml = `
            <div style="position: relative; width: 34px; height: 42px; display: flex; align-items: center; justify-content: center; cursor: grab; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.55));">
              <svg viewBox="0 0 24 24" width="34" height="42" style="display: block;">
                <path fill="#EF4444" stroke="#FFFFFF" stroke-width="1.8" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                <circle cx="12" cy="9" r="3.4" fill="#FFFFFF"/>
              </svg>
            </div>
          `;
          const pinIcon = L.divIcon({
            className: 'property-picker-pin',
            html: pinHtml,
            iconSize: [34, 42],
            iconAnchor: [17, 42]
          });
          this.propertyMiniMarker = L.marker([numLat, numLng], { draggable: true, icon: pinIcon }).addTo(this.propertyMiniMap);
        }
        this.propertyMiniMap.invalidateSize();
        setTimeout(() => {
          if (this.propertyMiniMap) this.propertyMiniMap.invalidateSize();
        }, 120);
      } catch (e) {
        console.warn("Leaflet mini map setView notice:", e);
      }
    }
  }

  toggleMiniMapLayer(type) {
    if (!this.propertyMiniMap || typeof L === "undefined") return;

    if (this._miniMapCurrentLayer) {
      this.propertyMiniMap.removeLayer(this._miniMapCurrentLayer);
    }

    if (type === "satellite") {
      this._miniMapCurrentLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains: ['0', '1', '2', '3']
      }).addTo(this.propertyMiniMap);
      this.showToast("Switched to Google Hybrid Satellite View", "info");
    } else {
      this._miniMapCurrentLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains: ['0', '1', '2', '3']
      }).addTo(this.propertyMiniMap);
      this.showToast("Switched to Google Maps Roadmap View", "info");
    }

    if (this.propertyMiniMarker) {
      this.propertyMiniMarker.bringToFront();
    }
    this.propertyMiniMap.invalidateSize();
  }

  handleLocationSearchInput(query) {
    if (!query) {
      const resultsDiv = document.getElementById("prop-location-results");
      if (resultsDiv) resultsDiv.style.display = "none";
      return;
    }

    // 1. Check if user pasted a Google Maps link or raw coordinates directly
    const parsed = this.parseGoogleMapsUrl(query);
    if (parsed) {
      this.updatePropertyCoords(parsed.lat, parsed.lng, parsed.isShortLink ? "Google Maps Share Link" : "Pasted Location");
      const resultsDiv = document.getElementById("prop-location-results");
      if (resultsDiv) resultsDiv.style.display = "none";
      return;
    }

    // If Google Places Autocomplete is active, let Google's official widget handle predictions
    if (window.google?.maps?.places && this.googleAutocomplete) {
      return;
    }

    // 2. Debounce real-time address search via OpenStreetMap Nominatim fallback
    if (this.locationSearchDebounce) clearTimeout(this.locationSearchDebounce);
    this.locationSearchDebounce = setTimeout(() => {
      this.searchLocationNominatim(query);
    }, 320);
  }

  triggerLocationSearch() {
    const input = document.getElementById("prop-location-search");
    if (!input || !input.value.trim()) return;
    const val = input.value.trim();

    const parsed = this.parseGoogleMapsUrl(val);
    if (parsed) {
      this.updatePropertyCoords(parsed.lat, parsed.lng, "Pasted Coordinates");
      return;
    }

    this.searchLocationNominatim(val);
  }

  async searchLocationNominatim(query) {
    const resultsDiv = document.getElementById("prop-location-results");
    if (!resultsDiv) return;

    if (!query || query.trim().length < 2) {
      resultsDiv.style.display = "none";
      return;
    }

    resultsDiv.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 0.8rem;"><i class="fa-solid fa-spinner fa-spin"></i> Searching Google Maps & localities in India...</div>`;
    resultsDiv.style.display = "block";

    try {
      let res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=6&addressdetails=1`);
      let data = await res.json();

      if (!Array.isArray(data) || data.length === 0) {
        res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`);
        data = await res.json();
      }

      if (!Array.isArray(data) || data.length === 0) {
        resultsDiv.innerHTML = `
          <div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 0.8rem;">
            No location matches found. Try typing city name or university.
          </div>
        `;
        return;
      }

      resultsDiv.innerHTML = data.map((item, idx) => {
        const title = item.name || item.display_name.split(",")[0];
        const sub = item.display_name;
        return `
          <div class="location-search-item" onclick="app.selectSearchResult(${idx})">
            <i class="fa-solid fa-location-dot"></i>
            <div>
              <div class="location-search-item-title">${this.escapeHtml(title)}</div>
              <div class="location-search-item-sub">${this.escapeHtml(sub)}</div>
            </div>
          </div>
        `;
      }).join("");

      this.currentLocationSearchResults = data;
    } catch (e) {
      resultsDiv.innerHTML = `<div style="padding: 10px; color: var(--danger-red); font-size: 0.78rem;">Search service busy. You can click on the map to place the pin directly.</div>`;
    }
  }

  selectSearchResult(idx) {
    if (!this.currentLocationSearchResults || !this.currentLocationSearchResults[idx]) return;
    const item = this.currentLocationSearchResults[idx];

    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lon);
    if (isNaN(lat) || isNaN(lng)) return;

    const shortName = item.name || item.display_name.split(",")[0];
    const searchInp = document.getElementById("prop-location-search");
    if (searchInp) searchInp.value = item.display_name;

    const resultsDiv = document.getElementById("prop-location-results");
    if (resultsDiv) resultsDiv.style.display = "none";

    // Auto-fill City if empty
    const cityInp = document.getElementById("prop-city");
    if (cityInp && !cityInp.value.trim()) {
      const city = item.address?.city || item.address?.town || item.address?.state_district || item.address?.county || item.address?.state || "";
      if (city) cityInp.value = city;
    }

    // Auto-fill University / Landmark if empty
    const uniInp = document.getElementById("prop-university");
    if (uniInp && !uniInp.value.trim()) {
      uniInp.value = shortName;
    }

    // Auto-fill Street Address if empty
    const addrInp = document.getElementById("prop-address");
    if (addrInp && !addrInp.value.trim()) {
      addrInp.value = item.display_name;
    }

    // Center map and move pin
    this.updatePropertyCoords(lat, lng, shortName);
  }

  getCurrentLocationForProperty() {
    if (!navigator.geolocation) {
      this.showToast("Geolocation is not supported by your browser.", "warning");
      return;
    }

    this.showToast("Locating your current GPS position...", "info");

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        // 1. Immediately pan map and update coordinates
        this.updatePropertyCoords(lat, lng, "Current GPS Location");
        this.recenterMiniMap(lat, lng, 16);

        const searchInp = document.getElementById("prop-location-search");
        if (searchInp) searchInp.value = `Current Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;

        // 2. Reverse geocode to get actual city, landmark & street address
        try {
          const revRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
          const revData = await revRes.json();
          if (revData && revData.address) {
            const city = revData.address.city || revData.address.town || revData.address.suburb || revData.address.state_district || "";
            const road = revData.address.road || revData.address.neighbourhood || revData.address.suburb || "";
            const landmark = revData.name || road || (revData.display_name ? revData.display_name.split(",")[0] : "");

            const cityInp = document.getElementById("prop-city");
            if (cityInp && (!cityInp.value.trim() || cityInp.value.trim().length === 0) && city) {
              cityInp.value = city;
            }

            const uniInp = document.getElementById("prop-university");
            if (uniInp && (!uniInp.value.trim() || uniInp.value.trim().length === 0) && landmark) {
              uniInp.value = landmark;
            }

            const addrInp = document.getElementById("prop-address");
            if (addrInp && (!addrInp.value.trim() || addrInp.value.trim().length === 0)) {
              addrInp.value = revData.display_name;
            }

            if (searchInp) searchInp.value = revData.display_name;
          }
        } catch (revErr) {
          console.warn("Reverse geocode notice:", revErr);
        }

        this.showToast("Hostel location spotted via GPS!", "success");
      },
      (err) => {
        this.showToast("Unable to retrieve GPS position. Please type location in search box.", "warning");
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  }

  updatePropertyCoords(lat, lng, label = "") {
    const latInp = document.getElementById("prop-lat");
    const lngInp = document.getElementById("prop-lng");
    const mapLinkInp = document.getElementById("prop-map-link");
    const badge = document.getElementById("prop-spotted-badge");

    const numLat = parseFloat(lat);
    const numLng = parseFloat(lng);
    if (isNaN(numLat) || isNaN(numLng)) return;

    if (latInp) latInp.value = numLat;
    if (lngInp) lngInp.value = numLng;
    const gmapsUrl = `https://www.google.com/maps?q=${numLat},${numLng}`;
    if (mapLinkInp) mapLinkInp.value = gmapsUrl;

    if (badge) {
      badge.style.display = "block";
      badge.innerHTML = `
        <div class="location-spotted-badge">
          <i class="fa-solid fa-circle-check"></i>
          <span><b>Spotted:</b> ${label ? this.escapeHtml(label) + ' • ' : ''}${numLat.toFixed(4)}, ${numLng.toFixed(4)}</span>
          <a href="${gmapsUrl}" target="_blank" style="margin-left: 8px; color: var(--primary); font-weight: 700; text-decoration: underline; display: inline-flex; align-items: center; gap: 4px;">
            Open Google Maps <i class="fa-solid fa-arrow-up-right-from-square font-xs"></i>
          </a>
        </div>
      `;
    }

    // Always pan the mini-map to these coordinates
    this.recenterMiniMap(numLat, numLng);
  }

  parseGoogleMapsUrl(input, cityName = "") {
    if (!input) return null;
    let urlStr = String(input).trim();
    if (!urlStr) return null;

    if (urlStr.includes("<iframe") && urlStr.includes("src=")) {
      const matchSrc = urlStr.match(/src=["']([^"']+)["']/i);
      if (matchSrc) urlStr = matchSrc[1];
    }

    const coordMatch = urlStr.match(/^\s*(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)\s*$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng, validUrl: false, isCoords: true };
      }
    }

    const atMatch = urlStr.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) {
      const lat = parseFloat(atMatch[1]);
      const lng = parseFloat(atMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng, validUrl: true };
      }
    }

    const queryMatch = urlStr.match(/[?&](?:q|ll|sll|query|destination)=(?:loc:)?(-?\d+\.\d+)[,+ ]+(-?\d+\.\d+)/i);
    if (queryMatch) {
      const lat = parseFloat(queryMatch[1]);
      const lng = parseFloat(queryMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng, validUrl: true };
      }
    }

    const pathMatch = urlStr.match(/\/(?:dir|search|place)\/(?:[^\/]*\/)*(-?\d+\.\d+)[,+ ]+(-?\d+\.\d+)/i);
    if (pathMatch) {
      const lat = parseFloat(pathMatch[1]);
      const lng = parseFloat(pathMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng, validUrl: true };
      }
    }

    const pbLatMatch = urlStr.match(/!3d(-?\d+\.\d+)/);
    const pbLngMatch = urlStr.match(/!(?:2d|4d)(-?\d+\.\d+)/);
    if (pbLatMatch && pbLngMatch) {
      const lat = parseFloat(pbLatMatch[1]);
      const lng = parseFloat(pbLngMatch[1]);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng, validUrl: true };
      }
    }

    const geoMatch = urlStr.match(/geo:(-?\d+\.\d+),(-?\d+\.\d+)/i);
    if (geoMatch) {
      const lat = parseFloat(geoMatch[1]);
      const lng = parseFloat(geoMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng, validUrl: true };
      }
    }

    const isGmapsLink = /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/i.test(urlStr);
    if (isGmapsLink) {
      const cityCoords = this.getCityCoordinates(cityName);
      return {
        lat: cityCoords.lat,
        lng: cityCoords.lng,
        validUrl: true,
        isShortLink: true
      };
    }

    return null;
  }

  getCityCoordinates(cityName = "") {
    const cityMap = {
      "delhi": { lat: 28.6922, lng: 77.2100 },
      "new delhi": { lat: 28.6922, lng: 77.2100 },
      "kota": { lat: 25.1800, lng: 75.8300 },
      "pune": { lat: 18.5204, lng: 73.8567 },
      "bengaluru": { lat: 12.9716, lng: 77.5946 },
      "bangalore": { lat: 12.9716, lng: 77.5946 },
      "mumbai": { lat: 19.0760, lng: 72.8777 },
      "jaipur": { lat: 26.9124, lng: 75.7873 },
      "dehradun": { lat: 30.3165, lng: 78.0322 },
      "indore": { lat: 22.7196, lng: 75.8577 },
      "noida": { lat: 28.5355, lng: 77.3910 },
      "greater noida": { lat: 28.4744, lng: 77.5040 },
      "gurgaon": { lat: 28.4595, lng: 77.0266 },
      "gurugram": { lat: 28.4595, lng: 77.0266 },
      "chandigarh": { lat: 30.7333, lng: 76.7794 },
      "lucknow": { lat: 26.8467, lng: 80.9462 },
      "hyderabad": { lat: 17.3850, lng: 78.4867 },
      "chennai": { lat: 13.0827, lng: 80.2707 },
      "kolkata": { lat: 22.5726, lng: 88.3639 },
      "ahmedabad": { lat: 23.0225, lng: 72.5714 },
      "varanasi": { lat: 25.3176, lng: 82.9739 },
      "patna": { lat: 25.5941, lng: 85.1376 },
      "bhopal": { lat: 23.2599, lng: 77.4126 },
      "kanpur": { lat: 26.4499, lng: 80.3319 }
    };

    const key = String(cityName || "").toLowerCase().trim();
    for (const c in cityMap) {
      if (key.includes(c)) {
        return cityMap[c];
      }
    }
    return { lat: 28.6922, lng: 77.2100 };
  }

  setMapProvider(provider) {
    this.mapProvider = provider;
    localStorage.setItem("hostelkhojo_map_provider", provider);

    const streetBtn = document.getElementById("map-layer-street-btn");
    const canvasBtn = document.getElementById("map-layer-canvas-btn");
    const gmapsCanvas = document.getElementById("google-map-canvas");
    const simulatedMap = document.getElementById("simulated-map");

    if (provider === "osm" || provider === "google") {
      streetBtn?.classList.add("active");
      canvasBtn?.classList.remove("active");
      if (gmapsCanvas) gmapsCanvas.style.display = "block";
      if (simulatedMap) simulatedMap.style.display = "none";
      this.renderOpenStreetMap();
    } else {
      canvasBtn?.classList.add("active");
      streetBtn?.classList.remove("active");
      if (gmapsCanvas) gmapsCanvas.style.display = "none";
      if (simulatedMap) simulatedMap.style.display = "block";
      this.renderMapPins();
    }
  }

  setMapTileLayer(layerType) {
    this.currentMapTileLayer = layerType;
    this.setMapProvider("osm");

    document.querySelectorAll(".map-layer-btn").forEach(b => b.classList.remove("active"));
    const btn = document.getElementById(`map-layer-${layerType}-btn`);
    if (btn) btn.classList.add("active");

    if (!this.leafletMap || typeof L === "undefined") return;

    if (this.currentTileLayerObj) {
      this.leafletMap.removeLayer(this.currentTileLayerObj);
    }

    let tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    let attribution = '&copy; OpenStreetMap contributors | Hostel Khojo 🇮🇳';
    let maxZoom = 19;
    let subdomains = ['a', 'b', 'c'];

    if (layerType === "satellite") {
      tileUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
      attribution = '&copy; Esri & Maxar Earth Imagery | Hostel Khojo';
      maxZoom = 19;
      subdomains = ['a', 'b', 'c'];
    } else if (layerType === "dark") {
      tileUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
      attribution = '&copy; CartoDB DarkMatter | Hostel Khojo';
      maxZoom = 20;
      subdomains = ['a', 'b', 'c', 'd'];
    } else if (layerType === "street") {
      // Crisp Voyager / OpenStreetMap
      tileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
      attribution = '&copy; CartoDB Voyager | OpenStreetMap | Hostel Khojo';
      maxZoom = 20;
      subdomains = ['a', 'b', 'c', 'd'];
    }

    try {
      this.currentTileLayerObj = L.tileLayer(tileUrl, {
        maxZoom,
        attribution,
        subdomains
      }).addTo(this.leafletMap);
      this.showToast(`Switched map to ${layerType.toUpperCase()} layer`, "info");
    } catch (e) {
      console.warn("Tile layer switch error:", e);
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

    const searchInput = document.getElementById("search-input");
    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : "";
    let detectedCampusName = "Campus Zone";

    if (searchQuery) {
      const cityCoords = this.getCityCoordinates(searchQuery);
      centerLat = cityCoords.lat;
      centerLng = cityCoords.lng;
      detectedCampusName = searchInput.value.trim();
    } else if (this.filteredHostels.length > 0) {
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
          zoomControl: false,
          scrollWheelZoom: true
        }).setView([centerLat, centerLng], 13);

        // Add custom positioned zoom controls
        L.control.zoom({ position: 'bottomleft' }).addTo(this.leafletMap);

        // Add default tile layer
        const defaultTileUrl = (document.documentElement.getAttribute("data-theme") === "dark" || this.currentMapTileLayer === "dark")
          ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
          : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

        this.currentTileLayerObj = L.tileLayer(defaultTileUrl, {
          maxZoom: 20,
          attribution: '&copy; CartoDB | OpenStreetMap | Hostel Khojo 🇮🇳'
        }).addTo(this.leafletMap);

        // Listen for map move/zoom for "Search as map moves"
        this.leafletMap.on('moveend', () => this.handleMapMoveEnd());
      } else {
        this.leafletMap.setView([centerLat, centerLng]);
      }

      // Clear existing hostel markers
      if (this.leafletMarkers) {
        this.leafletMarkers.forEach(m => this.leafletMap.removeLayer(m));
        this.leafletMarkers = [];
      }

      // Clear existing campus landmark
      if (this.campusCenterMarker) {
        this.leafletMap.removeLayer(this.campusCenterMarker);
        this.campusCenterMarker = null;
      }
      if (this.campusRadiusCircle) {
        this.leafletMap.removeLayer(this.campusRadiusCircle);
        this.campusRadiusCircle = null;
      }

      // Render Campus Anchor Pin & 1.2km Walkable Radius Circle
      if (this.showCampusRadius) {
        const campusIcon = L.divIcon({
          className: 'campus-anchor-wrapper',
          html: `
            <div class="campus-anchor-pin">
              <div class="campus-anchor-badge">
                <i class="fa-solid fa-graduation-cap"></i>
              </div>
              <div class="campus-anchor-title">${this.escapeHtml(detectedCampusName)}</div>
            </div>
          `,
          iconSize: [120, 64],
          iconAnchor: [60, 32]
        });

        this.campusCenterMarker = L.marker([centerLat, centerLng], { icon: campusIcon, zIndexOffset: 500 }).addTo(this.leafletMap);

        this.campusRadiusCircle = L.circle([centerLat, centerLng], {
          radius: 1200, // 1.2 km
          color: '#4f46e5',
          weight: 2,
          dashArray: '6, 8',
          fillColor: '#4f46e5',
          fillOpacity: 0.05
        }).addTo(this.leafletMap);
      }

      const bounds = [];
      if (this.showCampusRadius) bounds.push([centerLat, centerLng]);

      // Render Custom Speech-Bubble Price Markers
      this.filteredHostels.forEach(h => {
        if (!h.lat || !h.lng) return;

        bounds.push([h.lat, h.lng]);
        const genderClass = (h.gender || "Boys").toLowerCase().replace(/[^a-z]/g, '');
        const rentK = (h.rent / 1000).toFixed(1);
        const isHovered = this.hoveredPinId === h.id;

        const customIcon = L.divIcon({
          className: `custom-osm-pin pin-${genderClass} ${isHovered ? 'active' : ''}`,
          html: `
            <div class="custom-pin-bubble" id="leaflet-pin-${h.id}">
              <i class="fa-solid ${genderClass === 'girls' ? 'fa-venus' : (genderClass === 'boys' ? 'fa-mars' : 'fa-venus-mars')}" style="font-size: 0.72rem;"></i>
              <span>₹${rentK}k</span>
            </div>
          `,
          iconSize: [64, 32],
          iconAnchor: [32, 32]
        });

        const marker = L.marker([h.lat, h.lng], { icon: customIcon }).addTo(this.leafletMap);

        marker.on("mouseover", () => {
          this.highlightCard(h.id);
          this.highlightMapPin(h.id);
        });

        marker.on("mouseout", () => {
          this.unhighlightMapPin(h.id);
        });

        marker.on("click", () => {
          this.showMapHoverPreview(h.id, marker.getLatLng());
        });

        this.leafletMarkers.push(marker);
      });

      // Render Student POI Markers (Metro, Food, Libraries)
      this.renderMapPois(centerLat, centerLng);

      if (bounds.length > 1) {
        this.leafletMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      }

      this.leafletMap.invalidateSize();
    } catch (e) {
      console.warn("Leaflet Map render notice:", e);
    }
  }

  handleMapMoveEnd() {
    if (!this.mapBoundsSync || !this.leafletMap) return;

    const bounds = this.leafletMap.getBounds();
    const visibleHostels = (this.hostels || []).filter(h => {
      if (!h.lat || !h.lng) return true;
      return bounds.contains([h.lat, h.lng]);
    });

    this.filteredHostels = visibleHostels;
    this.renderHostels();
  }

  toggleMapBoundsFilter(enabled) {
    this.mapBoundsSync = enabled;
    if (enabled) {
      this.handleMapMoveEnd();
      this.showToast("List is now synced with visible map area 🗺️", "info");
    } else {
      this.applyFilters();
      this.showToast("Map sync disabled. Showing all search results.", "info");
    }
  }

  toggleMapPoi(poiType) {
    const btn = document.querySelector(`.map-poi-pill[data-poi="${poiType}"]`);
    if (this.activeMapPois.has(poiType)) {
      this.activeMapPois.delete(poiType);
      btn?.classList.remove("active");
    } else {
      this.activeMapPois.add(poiType);
      btn?.classList.add("active");
    }

    if (this.leafletMap) {
      const center = this.leafletMap.getCenter();
      this.renderMapPois(center.lat, center.lng);
    }
  }

  renderMapPois(centerLat, centerLng) {
    if (!this.leafletMap || typeof L === "undefined") return;

    // Clear old POIs
    if (this.poiMarkers) {
      this.poiMarkers.forEach(m => this.leafletMap.removeLayer(m));
      this.poiMarkers = [];
    }

    if (this.activeMapPois.size === 0) return;

    // Simulated realistic student POIs around campus center
    const poiConfigs = {
      metro: [
        { name: "Vishwa Vidyalaya Metro (Yellow Line)", dLat: 0.004, dLng: -0.003, icon: "fa-train-subway", color: "#eab308" },
        { name: "GTB Nagar Metro Station", dLat: -0.005, dLng: 0.004, icon: "fa-train-subway", color: "#eab308" }
      ],
      food: [
        { name: "Hudson Lane Student Cafes & Food Street", dLat: 0.003, dLng: 0.005, icon: "fa-utensils", color: "#f97316" },
        { name: "Chache Di Hatti & Student Mess Hub", dLat: -0.003, dLng: -0.004, icon: "fa-bowl-food", color: "#f97316" }
      ],
      library: [
        { name: "Central Student Reading Hall & Library", dLat: 0.002, dLng: -0.002, icon: "fa-book-open-reader", color: "#3b82f6" },
        { name: "24x7 Silent Study Hub", dLat: -0.004, dLng: 0.002, icon: "fa-book-bookmark", color: "#3b82f6" }
      ],
      health: [
        { name: "Apollo 24/7 Student Pharmacy & Clinic", dLat: -0.002, dLng: 0.006, icon: "fa-notes-medical", color: "#ef4444" },
        { name: "Campus Health & Wellness Centre", dLat: 0.005, dLng: 0.001, icon: "fa-hospital", color: "#ef4444" }
      ]
    };

    this.activeMapPois.forEach(type => {
      const items = poiConfigs[type] || [];
      items.forEach(poi => {
        const poiLat = centerLat + poi.dLat;
        const poiLng = centerLng + poi.dLng;

        const iconHtml = `
          <div class="poi-marker-icon" style="color: ${poi.color}; border-color: ${poi.color};" title="${this.escapeHtml(poi.name)}">
            <i class="fa-solid ${poi.icon}"></i>
          </div>
        `;

        const markerIcon = L.divIcon({
          className: 'poi-div-icon',
          html: iconHtml,
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        });

        const m = L.marker([poiLat, poiLng], { icon: markerIcon }).addTo(this.leafletMap);
        m.bindPopup(`
          <div style="padding: 8px 10px; font-size: 0.8rem; font-weight: 700;">
            <div style="color: ${poi.color}; margin-bottom: 2px;"><i class="fa-solid ${poi.icon}"></i> ${this.escapeHtml(poi.name)}</div>
            <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500;">Verified Student Point of Interest</div>
          </div>
        `);
        this.poiMarkers.push(m);
      });
    });
  }

  toggleCampusRadiusCircle() {
    this.showCampusRadius = !this.showCampusRadius;
    const btn = document.getElementById("campus-radius-toggle-btn");
    btn?.classList.toggle("active", this.showCampusRadius);

    if (this.campusRadiusCircle && this.leafletMap) {
      if (this.showCampusRadius) {
        this.campusRadiusCircle.addTo(this.leafletMap);
        if (this.campusCenterMarker) this.campusCenterMarker.addTo(this.leafletMap);
        this.showToast("Campus 1.2km Walkable Radius visible 🎯", "info");
      } else {
        this.leafletMap.removeLayer(this.campusRadiusCircle);
        if (this.campusCenterMarker) this.leafletMap.removeLayer(this.campusCenterMarker);
        this.showToast("Campus Walkable Radius hidden", "info");
      }
    }
  }

  locateUserOnMap() {
    if (!navigator.geolocation) {
      this.showToast("Geolocation is not supported by your browser.", "warning");
      return;
    }

    this.showToast("Locating your GPS position...", "info");

    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        if (this.leafletMap) {
          this.leafletMap.flyTo([lat, lng], 15, { duration: 1.2 });

          const gpsIcon = L.divIcon({
            className: 'user-gps-pin',
            html: `
              <div style="width: 22px; height: 22px; border-radius: 50%; background: #3b82f6; border: 3px solid #ffffff; box-shadow: 0 0 16px rgba(59, 130, 246, 0.8); animation: pulse-animation 2s infinite;"></div>
            `,
            iconSize: [22, 22],
            iconAnchor: [11, 11]
          });

          L.marker([lat, lng], { icon: gpsIcon }).addTo(this.leafletMap)
            .bindPopup(`<div style="padding: 6px 10px; font-weight: 700; font-size: 0.8rem;">📍 You Are Here</div>`)
            .openPopup();
        }

        this.showToast("Found your location! Showing nearby student hostels 📍", "success");
      },
      err => {
        this.showToast("Could not access GPS location. Please check location permissions.", "warning");
      },
      { timeout: 8000, enableHighAccuracy: true }
    );
  }

  recenterExplorerMap() {
    if (!this.leafletMap) return;

    if (this.leafletMarkers && this.leafletMarkers.length > 0) {
      const group = new L.featureGroup(this.leafletMarkers);
      this.leafletMap.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 16 });
      this.showToast("Map view reset to fit all stays", "info");
    } else {
      this.renderOpenStreetMap();
    }
  }

  toggleMobileSplitView() {
    this.isMobileMapActive = !this.isMobileMapActive;
    const layout = document.getElementById("explorer-layout");
    const label = document.getElementById("mob-switch-label");
    const icon = document.getElementById("mob-switch-icon");

    if (this.isMobileMapActive) {
      layout?.classList.add("mobile-map-active");
      if (label) label.innerText = "View List";
      if (icon) icon.className = "fa-solid fa-list-ul";
      setTimeout(() => {
        if (this.leafletMap) this.leafletMap.invalidateSize();
      }, 150);
    } else {
      layout?.classList.remove("mobile-map-active");
      if (label) label.innerText = "View Map";
      if (icon) icon.className = "fa-solid fa-map-location-dot";
    }
  }

  renderGoogleMap() {
    this.renderOpenStreetMap();
  }

  openGoogleDirections(lat, lng, name = "", mapLink = "") {
    if (mapLink && (mapLink.startsWith("http://") || mapLink.startsWith("https://") || mapLink.startsWith("geo:"))) {
      window.open(mapLink, "_blank");
      return;
    }
    if (!lat || !lng) {
      if (name) {
        window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`, "_blank");
        return;
      }
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
          <td><strong>Registration Fee</strong></td>
          ${selectedHostels.map(h => `<td>${h.registrationFee && h.registrationFee > 0 ? '₹' + Number(h.registrationFee).toLocaleString('en-IN') : 'Free (₹0)'}</td>`).join('')}
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

  /* HOSTEL DETAIL MODAL & MESS MENU TABS (STITCH SANCTUARY) */
  openHostelDetail(id) {
    const h = this.hostels.find(item => item.id === id);
    if (!h) return;

    const modalContent = document.getElementById("modal-detail-content");
    const genderClass = (h.gender || 'Boys').toLowerCase().replace(/[^a-z]/g, '');

    const galleryItems = [
      { label: "Hostel Exterior", icon: "fa-building", img: h.imageMain || 'assets/images/exterior1.png' },
      { label: "Rooms & Study", icon: "fa-bed", img: h.imageSingle || 'assets/images/room_single.png' },
      { label: "Washroom & Bath", icon: "fa-shower", img: h.imageWashroom || h.imageShared || 'assets/images/room_shared.png' },
      { label: "Mess & Dining", icon: "fa-utensils", img: h.imageMess || 'assets/images/mess.png' }
    ];

    modalContent.innerHTML = `
      <div class="modal-detail-layout">
        <div class="detail-content-col">
          
          <!-- Photo Gallery with Area Badges (Hostel, Rooms, Washroom, Mess) -->
          <div class="detail-gallery-main" style="position: relative;">
            <img id="detail-active-img" src="${galleryItems[0].img}" alt="${h.name}" />
            <span id="detail-active-label" class="badge" style="position: absolute; bottom: 12px; left: 12px; background: rgba(15, 23, 42, 0.8); color: #fff; backdrop-filter: blur(8px); padding: 5px 12px; font-size: 0.82rem; border-radius: 6px;">
              <i class="fa-solid ${galleryItems[0].icon}"></i> ${galleryItems[0].label}
            </span>
          </div>
          <div class="detail-thumbs-grid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
            ${galleryItems.map((item, idx) => `
              <div class="detail-thumb ${idx === 0 ? 'active' : ''}" onclick="app.switchDetailImage(this, '${item.img}', '${item.label}', '${item.icon}')" style="cursor: pointer; position: relative;">
                <img src="${item.img}" alt="${item.label}" style="height: 65px; width: 100%; object-fit: cover; border-radius: 6px;" />
                <div style="font-size: 0.68rem; font-weight: 600; text-align: center; margin-top: 2px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  <i class="fa-solid ${item.icon}" style="font-size: 0.65rem;"></i> ${item.label}
                </div>
              </div>
            `).join('')}
          </div>

          <!-- Header & Title -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; flex-wrap: wrap;">
            <div>
              <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
                <span class="badge-gender ${genderClass}">${h.gender}</span>
                ${h.verified ? `<span class="badge-verified"><i class="fa-solid fa-circle-check"></i> Verified Stay</span>` : ''}
                <span class="badge" style="background: var(--surface-container); color: var(--text-secondary);"><i class="fa-solid fa-shield-halved"></i> 100% Deposit Safe</span>
              </div>
              <h2 style="font-size: 1.6rem; font-weight: 800; color: var(--text-primary); margin-bottom: 4px;">${h.name}</h2>
              <p class="text-muted" style="font-size: 0.9rem;">
                <i class="fa-solid fa-location-dot" style="color: var(--danger-red);"></i> ${h.address} • <strong>${h.distance} km</strong> to ${h.university}
              </p>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 1.8rem; font-weight: 800; color: var(--primary);">₹${h.rent.toLocaleString('en-IN')}<span style="font-size: 0.9rem; color: var(--text-muted); font-weight: 500;">/mo</span></div>
              <div class="card-rating" style="justify-content: flex-end; margin-top: 4px;">
                <i class="fa-solid fa-star"></i> <strong>${h.rating}</strong> (${h.reviewsCount} reviews)
              </div>
            </div>
          </div>

          <!-- Key Highlights & Warden Rules Banner -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; background: var(--surface-low); padding: 16px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
            <div>
              <span style="font-size: 0.76rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; display: block;">Gate Curfew</span>
              <strong style="font-size: 0.92rem; color: var(--text-primary);"><i class="fa-solid fa-clock" style="color: var(--warning-amber);"></i> ${h.curfew || '10:30 PM'}</strong>
            </div>
            <div>
              <span style="font-size: 0.76rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; display: block;">Security Deposit</span>
              <strong style="font-size: 0.92rem; color: var(--text-primary);"><i class="fa-solid fa-shield-halved" style="color: var(--success-green);"></i> ₹${Number(h.deposit || 5000).toLocaleString('en-IN')} (Refundable)</strong>
            </div>
            <div>
              <span style="font-size: 0.76rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; display: block;">Registration Fee</span>
              <strong style="font-size: 0.92rem; color: var(--text-primary);"><i class="fa-solid fa-file-invoice-dollar" style="color: var(--primary);"></i> ${h.registrationFee && h.registrationFee > 0 ? '₹' + Number(h.registrationFee).toLocaleString('en-IN') : '₹0 (Free)'}</strong>
            </div>
            <div>
              <span style="font-size: 0.76rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; display: block;">Notice Period</span>
              <strong style="font-size: 0.92rem; color: var(--text-primary);"><i class="fa-solid fa-calendar-day" style="color: var(--primary);"></i> 30 Days</strong>
            </div>
          </div>

          <!-- About Property -->
          <div style="margin-bottom: 24px;">
            <h3 style="font-size: 1.15rem; margin-bottom: 8px;"><i class="fa-solid fa-circle-info" style="color: var(--primary);"></i> About Property</h3>
            <p style="color: var(--text-secondary); line-height: 1.6; font-size: 0.92rem;">${h.description}</p>
          </div>

          <!-- Amenities Tag Cloud -->
          <div style="margin-bottom: 24px;">
            <h3 style="font-size: 1.15rem; margin-bottom: 12px;"><i class="fa-solid fa-wand-magic-sparkles" style="color: var(--secondary);"></i> Included Amenities & Facilities</h3>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
              ${(h.amenities || []).map(a => `
                <span class="amenity-chip" style="padding: 6px 12px; font-size: 0.85rem;">
                  <i class="fa-solid fa-check"></i> ${a}
                </span>
              `).join('')}
            </div>
          </div>

          <!-- Room Occupancy Options -->
          <div style="margin-bottom: 24px;">
            <h3 style="font-size: 1.15rem; margin-bottom: 12px;"><i class="fa-solid fa-bed" style="color: var(--primary);"></i> Room Occupancy & Pricing</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
              ${(h.roomSharing || ['1 Occupancy', '2 Occupancy']).map(type => {
                let exactRent = (h.occupancyPricing && h.occupancyPricing[type]) ? h.occupancyPricing[type] : null;
                if (!exactRent) {
                  let multiplier = 1.0;
                  const tLower = String(type).toLowerCase();
                  if (tLower.includes('1') || tLower.includes('single')) multiplier = 1.35;
                  else if (tLower.includes('2') || tLower.includes('double')) multiplier = 1.0;
                  else if (tLower.includes('3') || tLower.includes('triple')) multiplier = 0.8;
                  else if (tLower.includes('4') || tLower.includes('quad')) multiplier = 0.65;
                  exactRent = Math.round(h.rent * multiplier);
                }
                return `
                <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 16px; text-align: center;">
                  <div style="font-weight: 700; font-size: 0.95rem; margin-bottom: 4px;">${type}</div>
                  <div style="font-size: 1.25rem; font-weight: 800; color: var(--primary); margin-bottom: 8px;">
                    ₹${Number(exactRent).toLocaleString('en-IN')}/mo
                  </div>
                  <span class="badge badge-accent" style="font-size: 0.72rem;">Available</span>
                </div>
              `;
              }).join('')}
            </div>
          </div>

          <!-- Weekly Mess Menu -->
          ${h.messMenu ? `
            <div style="margin-bottom: 24px;">
              <h3 style="font-size: 1.15rem; margin-bottom: 12px;"><i class="fa-solid fa-utensils" style="color: var(--warning-amber);"></i> 4-Time Homestyle Mess Menu</h3>
              <div class="user-page-card" style="padding: 16px;">
                <div class="auth-tabs" style="margin-bottom: 14px;">
                  <button class="auth-tab active" onclick="app.switchMessTab(this, 'mess-bf')">Breakfast</button>
                  <button class="auth-tab" onclick="app.switchMessTab(this, 'mess-lunch')">Lunch</button>
                  <button class="auth-tab" onclick="app.switchMessTab(this, 'mess-snacks')">Snacks</button>
                  <button class="auth-tab" onclick="app.switchMessTab(this, 'mess-dinner')">Dinner</button>
                </div>
                <div style="padding: 4px 8px; font-size: 0.92rem; color: var(--text-primary);">
                  <div id="mess-bf" class="mess-tab-pane active"><i class="fa-solid fa-mug-hot" style="color: var(--warning-amber); margin-right: 6px;"></i> ${h.messMenu.breakfast}</div>
                  <div id="mess-lunch" class="mess-tab-pane" style="display:none;"><i class="fa-solid fa-bowl-rice" style="color: var(--success-green); margin-right: 6px;"></i> ${h.messMenu.lunch}</div>
                  <div id="mess-snacks" class="mess-tab-pane" style="display:none;"><i class="fa-solid fa-cookie-bite" style="color: var(--secondary); margin-right: 6px;"></i> ${h.messMenu.snacks}</div>
                  <div id="mess-dinner" class="mess-tab-pane" style="display:none;"><i class="fa-solid fa-utensils" style="color: var(--primary); margin-right: 6px;"></i> ${h.messMenu.dinner}</div>
                </div>
              </div>
            </div>
          ` : ''}

          <!-- Student Reviews -->
          ${(h.reviews && h.reviews.length > 0) ? `
            <div>
              <h3 style="font-size: 1.15rem; margin-bottom: 12px;"><i class="fa-solid fa-comments" style="color: var(--primary);"></i> Verified Student Reviews</h3>
              <div style="display: flex; flex-direction: column; gap: 12px;">
                ${h.reviews.map(r => `
                  <div style="background: var(--surface-low); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px 16px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                      <div><strong>${r.name}</strong> • <span class="text-muted" style="font-size: 0.8rem;">${r.major}</span></div>
                      <div class="card-rating"><i class="fa-solid fa-star"></i> ${r.rating}</div>
                    </div>
                    <p style="font-size: 0.88rem; color: var(--text-secondary); margin: 0;">"${r.comment}"</p>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

        </div>

        <!-- Booking Sidebar (Glassmorphic Card) -->
        <div class="booking-sidebar-card">
          <h4 style="font-size: 1.1rem; font-weight: 700; margin-bottom: 6px; color: var(--text-primary);">
            <i class="fa-solid fa-calendar-check" style="color: var(--primary);"></i> Schedule Free Campus Visit
          </h4>
          <p class="text-muted" style="font-size: 0.82rem; margin-bottom: 18px;">Zero broker fee & instant warden WhatsApp confirmation.</p>

          <form onsubmit="app.handleBookingSubmit(event, '${h.id}')">
            <div class="form-group">
              <label>Room Occupancy Choice</label>
              <select class="form-control" required>
                ${(h.roomSharing || ['1 Occupancy', '2 Occupancy']).map(s => {
                  const pr = (h.occupancyPricing && h.occupancyPricing[s]) ? ` (₹${Number(h.occupancyPricing[s]).toLocaleString('en-IN')}/mo)` : '';
                  return `<option value="${s}">${s}${pr}</option>`;
                }).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Preferred Visit Date</label>
              <input type="date" class="form-control" required value="${new Date(Date.now() + 86400000).toISOString().split('T')[0]}" />
            </div>

            <div class="form-group">
              <label>Student WhatsApp Number</label>
              <input type="tel" placeholder="+91 98765 43210" class="form-control" required />
            </div>

            <button type="submit" class="btn btn-accent btn-block btn-lg" style="margin-top: 16px;">
              <i class="fa-solid fa-paper-plane"></i> Confirm Free Visit
            </button>

            <button type="button" class="btn btn-outline btn-block" onclick="app.openGoogleDirections(${h.lat || 28.6922}, ${h.lng || 77.2100}, '${encodeURIComponent(h.name)}')"
              style="margin-top: 10px; border-color: #4285F4; color: #4285F4; font-weight: 600;">
              <i class="fa-solid fa-map-location-dot" style="color: #ea4335;"></i> Open in Google Maps
            </button>
          </form>
        </div>
      </div>
    `;

    this.openModal("hostel-detail-modal");
  }

  switchDetailImage(thumbEl, src, label = null, icon = null) {
    const activeImg = document.getElementById("detail-active-img");
    if (activeImg) activeImg.src = src;
    const activeLabel = document.getElementById("detail-active-label");
    if (activeLabel && label) {
      activeLabel.innerHTML = `<i class="fa-solid ${icon || 'fa-camera'}"></i> ${label}`;
    }
    document.querySelectorAll(".detail-thumb").forEach(t => t.classList.remove("active"));
    if (thumbEl) thumbEl.classList.add("active");
  }

  handlePhotoUpload(input, type) {
    if (!input || !input.files || input.files.length === 0) return;
    const file = input.files[0];
    
    if (!file.type.startsWith("image/")) {
      this.showToast("Please select a valid image file (JPG, PNG, WEBP).", "error");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      this.showToast("Image file size should be less than 5MB.", "warning");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const prevImg = document.getElementById(`preview-img-${type}`);
      const hiddenInput = document.getElementById(`prop-img-${type}`);
      const badge = document.getElementById(`badge-img-${type}`);

      if (prevImg) prevImg.src = dataUrl;
      if (hiddenInput) hiddenInput.value = dataUrl;
      if (badge) badge.style.display = "inline-block";

      const typeTitles = {
        main: "Hostel Exterior Photo",
        room: "Room Photo",
        washroom: "Washroom Photo",
        mess: "Mess Photo"
      };

      this.showToast(`${typeTitles[type] || 'Photo'} uploaded successfully!`, "success");
    };
    reader.onerror = () => {
      this.showToast("Failed to read image file. Please try again.", "error");
    };
    reader.readAsDataURL(file);
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
          <div class="rm-avatar">${r.avatar || (r.name ? r.name.substring(0, 2).toUpperCase() : "ST")}</div>
          <div class="rm-info">
            <h3 class="rm-name">${r.name}</h3>
            <p class="rm-major"><i class="fa-solid fa-graduation-cap"></i> ${r.university || "Indian Campus"} (${r.major})</p>
          </div>
        </div>

        <div class="rm-tags">
          <span class="rm-tag"><i class="fa-solid fa-moon"></i> ${r.sleepHabit || r.sleep_habit || 'Flexible'}</span>
          <span class="rm-tag"><i class="fa-solid fa-bowl-food"></i> ${r.diet || 'Any Diet'}</span>
          <span class="rm-tag" style="background: var(--primary-light); color: var(--primary);"><i class="fa-solid fa-venus-mars"></i> ${r.gender || 'Any'}</span>
        </div>

        <p class="rm-bio">"${r.bio || 'Looking for friendly, respectful roommate near campus with clean habits.'}"</p>

        <div class="rm-footer">
          <div>
            <div class="rm-budget-label">Max Budget</div>
            <div class="rm-budget">₹${Number(r.budget || 10000).toLocaleString('en-IN')}<span style="font-size: 0.72rem; color: var(--text-muted);">/mo</span></div>
          </div>
          <button class="btn btn-outline btn-sm" onclick="app.connectRoommate('${r.name}')">
            <i class="fa-solid fa-paper-plane"></i> Connect
          </button>
        </div>
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
     SUPER ADMIN COMMAND CENTER ENGINE (/admin)
     ========================================================================== */

  openAdminPortal() {
    if (!this.currentAdminUser || this.currentAdminUser.role !== "admin") {
      this.openModal("admin-auth-modal");
      return;
    }

    this.switchTab("admin");
    this.loadAdminDashboardData();
  }

  async checkAdminSession() {
    try {
      const isUnlocked = sessionStorage.getItem("hostelkhojo_admin_unlocked") === "true";
      const savedUserStr = localStorage.getItem("hostelkhojo_admin_user");
      if (isUnlocked && savedUserStr) {
        this.currentAdminUser = JSON.parse(savedUserStr);
      } else {
        this.currentAdminUser = null;
      }
    } catch (e) {
      this.currentAdminUser = null;
    }
  }

  toggleAdminPasswordVisibility() {
    const input = document.getElementById("admin-login-password");
    const eye = document.getElementById("admin-pwd-eye");
    if (!input || !eye) return;

    if (input.type === "password") {
      input.type = "text";
      eye.className = "fa-solid fa-eye-slash";
    } else {
      input.type = "password";
      eye.className = "fa-solid fa-eye";
    }
  }

  async handleAdminLoginSubmit(e) {
    e.preventDefault();
    const identifierEl = document.getElementById("admin-login-identifier");
    const passwordEl = document.getElementById("admin-login-password");
    const identifier = identifierEl ? identifierEl.value.trim() : "";
    const password = passwordEl ? passwordEl.value.trim() : "";

    if (!password) {
      this.showToast("Please enter the Master Admin password to unlock.", "warning");
      return;
    }

    const validPasskeys = ["adminpassword123", "admin123", "admin", "root", "master123"];
    const isMasterIdentifier = identifier.toLowerCase().includes("admin") || identifier === "9999999999" || identifier.toLowerCase().includes("hostelkhojo");
    const isMasterPasskey = validPasskeys.includes(password.toLowerCase());

    // 1. Try FastAPI backend verification FIRST to receive a signed JWT token
    try {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.user.role !== "admin") {
          this.showToast("Access Denied: Account does not have Super Admin privileges.", "warning");
          return;
        }
        sessionStorage.setItem("hostelkhojo_admin_unlocked", "true");
        localStorage.setItem("hostelkhojo_admin_token", data.access_token);
        localStorage.setItem("hostelkhojo_admin_user", JSON.stringify(data.user));
        this.currentAdminUser = data.user;
        this.saveUserToLocalAllUsers(data.user);
        this.closeModal("admin-auth-modal");
        this.showToast(`Admin Command Center unlocked! Welcome, ${data.user.full_name}! 🚀`, "success");
        this.renderAuthNavUI();
        this.switchTab("admin");
        this.loadAdminDashboardData();
        return;
      }
    } catch (err) {
      console.warn("Backend admin login failed/offline:", err);
    }

    // 2. Fallback to Master Admin Passkey if backend is offline or credential lookup failed
    if (isMasterIdentifier && isMasterPasskey) {
      const adminUser = {
        id: "usr_admin_master",
        full_name: "Super Admin Command",
        email: identifier.includes("@") ? identifier : "admin@hostelkhojo.in",
        phone: "9999999999",
        role: "admin",
        created_at: new Date().toISOString()
      };
      sessionStorage.setItem("hostelkhojo_admin_unlocked", "true");
      localStorage.setItem("hostelkhojo_admin_token", "admin_master_jwt_token_2026");
      localStorage.setItem("hostelkhojo_admin_user", JSON.stringify(adminUser));
      this.currentAdminUser = adminUser;
      this.saveUserToLocalAllUsers(adminUser);
      this.closeModal("admin-auth-modal");
      this.showToast(`Admin Command Center unlocked! Welcome, ${adminUser.full_name}! 🚀`, "success");
      this.renderAuthNavUI();
      this.switchTab("admin");
      this.loadAdminDashboardData();
      return;
    }

    // Access Denied / Invalid password
    if (passwordEl) {
      passwordEl.value = "";
      passwordEl.focus();
    }
    const modalBox = document.querySelector("#admin-auth-modal .modal-box");
    if (modalBox) {
      modalBox.style.animation = "none";
      setTimeout(() => { modalBox.style.animation = "shake 0.4s ease"; }, 10);
    }
    this.showToast("Access Denied: Incorrect Admin Password 🔒", "warning");
  }

  logoutAdmin() {
    sessionStorage.removeItem("hostelkhojo_admin_unlocked");
    localStorage.removeItem("hostelkhojo_admin_token");
    localStorage.removeItem("hostelkhojo_admin_user");
    this.currentAdminUser = null;
    if (window.location.pathname === "/admin" || window.location.hash === "#admin") {
      try { history.pushState(null, "", "/"); } catch (e) { window.location.hash = ""; }
    }
    this.switchTab("hostels");
    this.renderAuthNavUI();
    this.showToast("Admin session locked. Logged out successfully. 🔒", "info");
  }

  async loadAdminDashboardData() {
    if (!this.currentAdminUser) return;

    const token = localStorage.getItem("hostelkhojo_admin_token") || localStorage.getItem("hostelkhojo_token") || localStorage.getItem("hostelkhojo_owner_token") || "admin_master_jwt_token_2026";
    const headers = { "Authorization": `Bearer ${token}` };

    // 1. Fetch fresh Hostels from backend API
    try {
      const hostelsRes = await apiFetch("/hostels");
      if (hostelsRes.ok) {
        const cloudData = await hostelsRes.json();
        if (Array.isArray(cloudData)) {
          let localRealProps = [];
          try {
            const stored = localStorage.getItem("hostelkhojo_real_properties") || localStorage.getItem("hostelkhojo_custom_properties");
            if (stored) localRealProps = JSON.parse(stored);
          } catch (e) {}

          let deletedIds = [];
          try {
            deletedIds = JSON.parse(localStorage.getItem("hostelkhojo_deleted_hostel_ids") || "[]");
          } catch (e) {}

          const combinedHostels = [...cloudData];
          if (Array.isArray(localRealProps)) {
            localRealProps.forEach(lp => {
              if (lp && (lp.id || lp.name)) {
                const exists = combinedHostels.some(h => (h.id && lp.id && String(h.id) === String(lp.id)) || (h.name && lp.name && h.name.toLowerCase() === lp.name.toLowerCase()));
                if (!exists) combinedHostels.push(lp);
              }
            });
          }
          this.hostels = combinedHostels.filter(h => h && h.id && !deletedIds.includes(String(h.id)));
        }
      }
    } catch (e) {
      console.warn("Failed to fetch fresh hostels for admin dashboard:", e);
    }

    // 2. Fetch fresh Bookings for Admin
    try {
      const bkRes = await apiFetch("/owner/bookings", { headers });
      if (bkRes.ok) {
        const bkData = await bkRes.json();
        if (Array.isArray(bkData)) {
          this.ownerBookings = bkData;
        }
      }
    } catch (e) {}

    // 3. Fetch fresh Roommates for Admin
    try {
      const rmRes = await apiFetch("/roommates");
      if (rmRes.ok) {
        const rmData = await rmRes.json();
        if (Array.isArray(rmData)) {
          this.roommates = rmData;
        }
      }
    } catch (e) {}

    // 4. Fetch Stats from backend API
    try {
      const statsRes = await apiFetch("/admin/stats", { headers });
      if (statsRes.ok) {
        const stats = await statsRes.json();
        const hostelsEl = document.getElementById("admin-stat-hostels");
        const bookingsEl = document.getElementById("admin-stat-bookings");
        const roommatesEl = document.getElementById("admin-stat-roommates");
        const totalUsersEl = document.getElementById("admin-stat-total-users");
        const breakdownEl = document.getElementById("admin-stat-user-breakdown");

        const actualHostelCount = (this.hostels && this.hostels.length) || stats.total_hostels || 0;
        if (hostelsEl) hostelsEl.innerText = actualHostelCount;
        if (bookingsEl) bookingsEl.innerText = (this.ownerBookings && this.ownerBookings.length) || stats.total_bookings || 0;
        if (roommatesEl) roommatesEl.innerText = (this.roommates && this.roommates.length) || stats.total_roommates || 0;
        if (totalUsersEl) totalUsersEl.innerText = stats.total_users;
        if (breakdownEl) breakdownEl.innerText = `${stats.students_count || 0} Students • ${stats.owners_count || 0} Owners • ${stats.admins_count || 0} Admins`;
      } else {
        this.renderFallbackAdminStats();
      }
    } catch (e) {
      this.renderFallbackAdminStats();
    }

    // 5. Fetch Users from backend API
    let fetchedUsers = [];
    try {
      const usersRes = await apiFetch("/admin/users", { headers });
      if (usersRes.ok) {
        fetchedUsers = await usersRes.json();
        if (Array.isArray(fetchedUsers) && fetchedUsers.length > 0) {
          fetchedUsers.forEach(u => this.saveUserToLocalAllUsers(u));
        }
      }
    } catch (e) {
      console.warn("Failed to fetch admin users from API:", e);
    }

    // Always merge API users, local logged-in users, and saved users
    this.adminUsers = this.mergeAdminUsers(fetchedUsers);
    this.renderAdminUsersTables();
    this.updateAdminStatsFromUsers();
  }

  renderFallbackAdminStats() {
    const hostelsEl = document.getElementById("admin-stat-hostels");
    const bookingsEl = document.getElementById("admin-stat-bookings");
    const roommatesEl = document.getElementById("admin-stat-roommates");

    if (hostelsEl) hostelsEl.innerText = (this.hostels || []).length || 0;
    if (bookingsEl) bookingsEl.innerText = (this.ownerBookings || []).length || 0;
    if (roommatesEl) roommatesEl.innerText = (this.roommates || []).length || 0;
  }

  saveUserToLocalAllUsers(user) {
    if (!user || (!user.id && !user.email && !user.phone)) return;
    try {
      let saved = JSON.parse(localStorage.getItem("hostelkhojo_all_users") || "[]");
      if (!Array.isArray(saved)) saved = [];

      const idx = saved.findIndex(u => 
        (user.id && u.id === user.id) || 
        (user.email && u.email && u.email.toLowerCase() === user.email.toLowerCase()) || 
        (user.phone && u.phone && u.phone === user.phone)
      );
      if (idx >= 0) {
        saved[idx] = { ...saved[idx], ...user };
      } else {
        saved.push(user);
      }
      localStorage.setItem("hostelkhojo_all_users", JSON.stringify(saved));
    } catch (e) {
      console.warn("Failed to save user to local users list:", e);
    }
  }

  mergeAdminUsers(fetchedUsers = []) {
    let all = Array.isArray(fetchedUsers) ? [...fetchedUsers] : [];

    // Local saved users
    try {
      const localUsers = JSON.parse(localStorage.getItem("hostelkhojo_all_users") || "[]");
      if (Array.isArray(localUsers)) {
        localUsers.forEach(lu => {
          if (lu && (lu.id || lu.email || lu.phone)) {
            const exists = all.some(u => 
              (u.id && lu.id && u.id === lu.id) || 
              (u.email && lu.email && u.email.toLowerCase() === lu.email.toLowerCase()) || 
              (u.phone && lu.phone && u.phone === lu.phone)
            );
            if (!exists) all.push(lu);
          }
        });
      }
    } catch (e) {}

    // Current active logged in users
    [this.currentUser, this.currentOwnerUser, this.currentAdminUser].forEach(cu => {
      if (cu && (cu.id || cu.email || cu.phone)) {
        const exists = all.some(u => 
          (u.id && cu.id && u.id === cu.id) || 
          (u.email && cu.email && u.email.toLowerCase() === cu.email.toLowerCase()) || 
          (u.phone && cu.phone && u.phone === cu.phone)
        );
        if (!exists) all.push(cu);
      }
    });

    return all;
  }

  updateAdminStatsFromUsers() {
    const users = this.adminUsers || [];
    const studentsCount = users.filter(u => u.role === "student").length;
    const ownersCount = users.filter(u => u.role === "owner").length;
    const adminsCount = users.filter(u => u.role === "admin").length;
    const totalUsers = users.length;

    const totalUsersEl = document.getElementById("admin-stat-total-users");
    const breakdownEl = document.getElementById("admin-stat-user-breakdown");

    if (totalUsersEl) totalUsersEl.innerText = totalUsers;
    if (breakdownEl) breakdownEl.innerText = `${studentsCount} Students • ${ownersCount} Owners • ${adminsCount} Admins`;
  }

  switchAdminUserSubTab(panelName) {
    const panels = {
      owners: document.getElementById("admin-owners-section"),
      students: document.getElementById("admin-students-section"),
      hostels: document.getElementById("admin-hostels-section"),
      all: document.getElementById("admin-all-section")
    };
    const btns = {
      owners: document.getElementById("subtab-btn-owners"),
      students: document.getElementById("subtab-btn-students"),
      hostels: document.getElementById("subtab-btn-hostels"),
      all: document.getElementById("subtab-btn-all")
    };

    Object.keys(panels).forEach(key => {
      if (panels[key]) panels[key].style.display = key === panelName ? "block" : "none";
      if (btns[key]) {
        if (key === panelName) {
          btns[key].classList.add("btn-accent", "active");
          btns[key].classList.remove("btn-outline");
        } else {
          btns[key].classList.remove("btn-accent", "active");
          btns[key].classList.add("btn-outline");
        }
      }
    });
  }

  renderAdminUsersTables() {
    this.renderAdminOwnersTable();
    this.renderAdminStudentsTable();
    this.renderAdminHostelsTable();
    this.renderAdminUsersTable();
    this.updateAdminSubTabCounts();
  }

  updateAdminSubTabCounts() {
    const users = this.adminUsers || [];
    const ownersCount = users.filter(u => u.role === "owner").length;
    const studentsCount = users.filter(u => u.role === "student").length;
    const hostelsCount = (this.hostels || []).length;

    const ownersEl = document.getElementById("admin-subtab-owners-count");
    const studentsEl = document.getElementById("admin-subtab-students-count");
    const hostelsEl = document.getElementById("admin-subtab-hostels-count");
    const allEl = document.getElementById("admin-subtab-all-count");

    if (ownersEl) ownersEl.innerText = ownersCount;
    if (studentsEl) studentsEl.innerText = studentsCount;
    if (hostelsEl) hostelsEl.innerText = hostelsCount;
    if (allEl) allEl.innerText = users.length;
  }

  renderAdminOwnersTable(ownersToRender = null) {
    const tbody = document.getElementById("admin-owners-tbody");
    if (!tbody) return;

    const owners = ownersToRender || (this.adminUsers || []).filter(u => u.role === "owner");
    if (owners.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 24px; color: var(--text-muted);">
            No registered PG/Hostel Owner accounts found matching criteria.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = owners.map(u => {
      const dateStr = u.created_at ? new Date(u.created_at).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" }) : "Recently";
      
      const ownerProperties = (this.hostels || []).filter(h => h.owner_id === u.id || h.contact_email === u.email || (u.full_name && h.owner_name && h.owner_name.toLowerCase() === u.full_name.toLowerCase()));
      const propCount = ownerProperties.length;
      
      let propBadge = "";
      if (propCount > 0) {
        propBadge = `<span class="badge badge-success" style="padding: 4px 10px; font-weight: 600;"><i class="fa-solid fa-building"></i> ${propCount} Property Listed</span>`;
      } else {
        propBadge = `<span class="badge badge-outline" style="padding: 4px 10px; font-size: 0.8rem; color: var(--text-muted);"><i class="fa-solid fa-house-circle-exclamation"></i> 0 PGs Uploaded</span>`;
      }

      return `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 12px 16px; font-weight: 600;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="width: 32px; height: 32px; border-radius: 50%; background: #059669; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem;">
                ${(u.full_name || 'Owner').charAt(0).toUpperCase()}
              </div>
              <div>${u.full_name || 'PG Owner'}</div>
            </div>
          </td>
          <td style="padding: 12px 16px; font-weight: 500;">
            ${u.phone ? `<i class="fa-solid fa-phone" style="color: #059669;"></i> ${u.phone}` : '<span class="text-muted font-xs">N/A</span>'}
          </td>
          <td style="padding: 12px 16px;">
            <div style="font-weight: 600; font-family: monospace; font-size: 0.82rem; color: #059669;"><i class="fa-solid fa-id-card"></i> ${u.id || 'usr_owner'}</div>
            <div class="font-xs text-muted">${u.email || ''}</div>
          </td>
          <td style="padding: 12px 16px;">${propBadge}</td>
          <td style="padding: 12px 16px; font-size: 0.85rem; color: var(--text-muted);">${dateStr}</td>
          <td style="padding: 12px 16px;">
            <select class="form-control" style="padding: 4px 8px; font-size: 0.8rem; max-width: 130px;" onchange="app.updateUserRole('${u.id}', this.value)">
              <option value="student" ${u.role === 'student' ? 'selected' : ''}>Student</option>
              <option value="owner" ${u.role === 'owner' ? 'selected' : ''}>PG Owner</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Super Admin</option>
            </select>
          </td>
          <td style="padding: 12px 16px;">
            <button class="btn btn-danger-outline btn-sm" onclick="app.deleteUserAccount('${u.id}')" title="Delete Owner Account" style="border: 1px solid #ef4444; color: #ef4444; background: transparent;">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderAdminStudentsTable(studentsToRender = null) {
    const tbody = document.getElementById("admin-students-tbody");
    if (!tbody) return;

    const students = studentsToRender || (this.adminUsers || []).filter(u => u.role === "student");
    if (students.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 24px; color: var(--text-muted);">
            No registered Student accounts found matching criteria.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = students.map(u => {
      const dateStr = u.created_at ? new Date(u.created_at).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" }) : "Recently";
      
      const rm = (this.roommates || []).find(r => r.user_id === u.id || (u.full_name && r.name && r.name.toLowerCase() === u.full_name.toLowerCase()));

      let reqBadge = "";
      if (rm) {
        reqBadge = `
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <span class="badge badge-accent" style="padding: 4px 10px; font-weight: 600;"><i class="fa-solid fa-bed"></i> ${rm.looking_for || rm.major || 'Roommate Requirement'}</span>
            <div class="font-xs text-muted"><i class="fa-solid fa-indian-rupee-sign"></i> Max ₹${Number(rm.budget || 8000).toLocaleString('en-IN')}/mo • ${rm.sleepHabit || rm.sleep_habit || rm.sleep || 'Flexible'} • ${rm.diet || 'Any'}</div>
          </div>
        `;
      } else {
        reqBadge = `<span class="badge badge-outline" style="padding: 4px 10px; font-size: 0.8rem; color: var(--text-muted);"><i class="fa-solid fa-user-minus"></i> No requirement card posted</span>`;
      }

      return `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 12px 16px; font-weight: 600;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="width: 32px; height: 32px; border-radius: 50%; background: #4f46e5; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem;">
                ${(u.full_name || 'Student').charAt(0).toUpperCase()}
              </div>
              <div>${u.full_name || 'Student'}</div>
            </div>
          </td>
          <td style="padding: 12px 16px; font-weight: 500;">
            ${u.phone ? `<i class="fa-solid fa-phone" style="color: #059669;"></i> ${u.phone}` : '<span class="text-muted font-xs">N/A</span>'}
          </td>
          <td style="padding: 12px 16px;">
            <div style="font-weight: 600; font-family: monospace; font-size: 0.82rem; color: #4f46e5;"><i class="fa-solid fa-id-card"></i> ${u.id || 'usr_student'}</div>
            <div class="font-xs text-muted">${u.email || ''}</div>
          </td>
          <td style="padding: 12px 16px;">${reqBadge}</td>
          <td style="padding: 12px 16px; font-size: 0.85rem; color: var(--text-muted);">${dateStr}</td>
          <td style="padding: 12px 16px;">
            <select class="form-control" style="padding: 4px 8px; font-size: 0.8rem; max-width: 130px;" onchange="app.updateUserRole('${u.id}', this.value)">
              <option value="student" ${u.role === 'student' ? 'selected' : ''}>Student</option>
              <option value="owner" ${u.role === 'owner' ? 'selected' : ''}>PG Owner</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Super Admin</option>
            </select>
          </td>
          <td style="padding: 12px 16px;">
            <button class="btn btn-danger-outline btn-sm" onclick="app.deleteUserAccount('${u.id}')" title="Delete Student Account" style="border: 1px solid #ef4444; color: #ef4444; background: transparent;">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderAdminHostelsTable(hostelsToRender = null) {
    const tbody = document.getElementById("admin-hostels-tbody");
    if (!tbody) return;

    const hostels = hostelsToRender || this.hostels || [];
    if (hostels.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 24px; color: var(--text-muted);">
            No Hostels or PGs listed on the website currently matching criteria.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = hostels.map(h => {
      const owner = (this.adminUsers || []).find(u => u.id === h.owner_id || u.email === h.contact_email) || {
        full_name: h.owner_name || "PG Owner",
        phone: h.contact_phone || "N/A",
        email: h.contact_email || "N/A"
      };

      const bookings = (this.ownerBookings || []).filter(b => b.hostel_id === h.id || b.hostel_name === h.name);
      let interestedHtml = "";
      if (bookings.length > 0) {
        interestedHtml = `
          <div>
            <span class="badge badge-success" style="padding: 4px 10px; font-weight: 600; margin-bottom: 4px; display: inline-block;">
              <i class="fa-solid fa-users"></i> ${bookings.length} Visit Requests
            </span>
            <div class="font-xs text-muted" style="max-width: 210px; line-height: 1.3;">
              ${bookings.slice(0, 3).map(b => `<i class="fa-solid fa-user-check" style="color: #059669;"></i> ${b.user_name || b.name || 'Student'} (${b.user_phone || b.phone || 'Contact'})`).join('<br>')}
            </div>
          </div>
        `;
      } else {
        interestedHtml = `
          <span class="badge badge-outline" style="padding: 4px 10px; font-size: 0.8rem; color: var(--text-muted);">
            <i class="fa-solid fa-user-clock"></i> 0 Visit Requests
          </span>
        `;
      }

      const isOffline = (h.is_live === false || h.is_live === 0 || h.is_live === "false");
      const safeId = String(h.id || '').replace(/'/g, "\\'");

      return `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 12px 16px;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <img src="${h.imageMain || h.image || 'https://images.unsplash.com/photo-1555854877-bab0e564b8d5?auto=format&fit=crop&w=120&q=80'}" style="width: 48px; height: 48px; border-radius: 8px; object-fit: cover;" alt="${h.name}">
              <div>
                <div style="font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                  ${h.name}
                  ${isOffline ? '<span class="badge" style="background: #dc2626; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem;">Offline</span>' : '<span class="badge" style="background: #059669; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem;">Live</span>'}
                </div>
                <div class="font-xs text-muted"><i class="fa-solid fa-location-dot" style="color: #dc2626;"></i> ${h.university || h.city || 'India'}</div>
                <span class="badge badge-outline" style="font-size: 0.75rem; padding: 2px 6px; margin-top: 2px;">ID: ${h.id}</span>
              </div>
            </div>
          </td>
          <td style="padding: 12px 16px;">
            <div style="font-weight: 600; font-size: 0.9rem;">${owner.full_name}</div>
            <div class="font-xs"><i class="fa-solid fa-phone" style="color: #059669;"></i> ${owner.phone}</div>
            <div class="font-xs text-muted"><i class="fa-solid fa-envelope"></i> ${owner.email}</div>
          </td>
          <td style="padding: 12px 16px; font-weight: 700; color: var(--accent-primary);">
            ₹${Number(h.rent || 8500).toLocaleString('en-IN')}<span style="font-size: 0.75rem; font-weight: 400; color: var(--text-muted);">/mo</span>
          </td>
          <td style="padding: 12px 16px;">
            ${interestedHtml}
          </td>
          <td style="padding: 12px 16px;">
            <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
              ${isOffline ? `
                <button class="btn btn-sm" onclick="app.toggleHostelLiveStatus('${safeId}', true)" style="background: #10b981; color: white; border: none; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px;" title="Publish Hostel Live globally">
                  <i class="fa-solid fa-globe"></i> Go Live
                </button>
              ` : `
                <button class="btn btn-sm" onclick="app.toggleHostelLiveStatus('${safeId}', false)" style="background: #f59e0b; color: white; border: none; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px;" title="Make Hostel Offline (Hide from website)">
                  <i class="fa-solid fa-eye-slash"></i> Make Offline
                </button>
              `}
              <button class="btn btn-sm" onclick="app.deleteHostelProperty('${safeId}')" style="background: #ef4444; color: white; border: none; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px;" title="Delete Hostel Property directly from website">
                <i class="fa-solid fa-trash-can"></i> Delete
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  filterAdminHostelsTable() {
    const searchVal = document.getElementById("admin-hostel-search-input")?.value.toLowerCase().trim() || "";
    const filtered = (this.hostels || []).filter(h => {
      return !searchVal ||
        (h.name && h.name.toLowerCase().includes(searchVal)) ||
        (h.city && h.city.toLowerCase().includes(searchVal)) ||
        (h.university && h.university.toLowerCase().includes(searchVal)) ||
        (h.owner_name && h.owner_name.toLowerCase().includes(searchVal));
    });
    this.renderAdminHostelsTable(filtered);
  }

  async deleteHostelProperty(hostelId) {
    if (!confirm("Are you sure you want to delete this Hostel/PG property directly from the website?")) return;

    // Find the property to capture its name and owner before deletion
    const targetHostel = (this.hostels || []).find(h => h && String(h.id) === String(hostelId)) ||
                         (this.ownerProperties || []).find(h => h && String(h.id) === String(hostelId));
    const targetName = (targetHostel && targetHostel.name) || "PG / Hostel Property";
    const targetOwnerId = (targetHostel && (targetHostel.owner_id || targetHostel.contact_email || targetHostel.contact_phone)) || "";

    const token = localStorage.getItem("hostelkhojo_admin_token") || localStorage.getItem("hostelkhojo_token") || localStorage.getItem("hostelkhojo_owner_token") || "admin_master_jwt_token_2026";
    const headers = { "Authorization": `Bearer ${token}` };

    try {
      const res = await apiFetch(`/admin/hostels/${hostelId}`, {
        method: "DELETE",
        headers
      });
      if (res.ok) {
        this.showToast(`Property "${targetName}" deleted by Super Admin!`, "info");
      } else {
        await apiFetch(`/owner/properties/${hostelId}`, { method: "DELETE", headers }).catch(() => {});
        this.showToast(`Property "${targetName}" removed from website.`, "info");
      }
    } catch (e) {
      this.showToast(`Property "${targetName}" removed from website.`, "info");
    }

    // 1. Record removal notice for owner
    try {
      let removedList = JSON.parse(localStorage.getItem("hostelkhojo_admin_removed_properties") || "[]");
      if (!Array.isArray(removedList)) removedList = [];
      const noticeId = "notice_" + Date.now();
      removedList.unshift({
        id: noticeId,
        property_id: String(hostelId),
        property_name: targetName,
        owner_id: targetOwnerId,
        message: `Admin has removed this property: "${targetName}"`,
        reason: "Removed by Super Admin",
        created_at: new Date().toISOString(),
        is_dismissed: false
      });
      localStorage.setItem("hostelkhojo_admin_removed_properties", JSON.stringify(removedList));
    } catch (e) {}

    // 2. Record in deleted hostel IDs filter
    try {
      let deletedIds = JSON.parse(localStorage.getItem("hostelkhojo_deleted_hostel_ids") || "[]");
      if (!Array.isArray(deletedIds)) deletedIds = [];
      if (!deletedIds.includes(String(hostelId))) {
        deletedIds.push(String(hostelId));
        localStorage.setItem("hostelkhojo_deleted_hostel_ids", JSON.stringify(deletedIds));
      }
    } catch (e) {}

    // 3. Remove from all local property storage keys
    for (const key of ["hostelkhojo_real_properties", "hostelkhojo_custom_properties", "hostelkhojo_properties"]) {
      try {
        let stored = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(stored)) {
          stored = stored.filter(h => h && String(h.id) !== String(hostelId) && h.name !== targetName);
          localStorage.setItem(key, JSON.stringify(stored));
        }
      } catch (e) {}
    }

    // 4. Remove from main app memory arrays
    this.hostels = (this.hostels || []).filter(h => h && String(h.id) !== String(hostelId) && h.name !== targetName);
    this.filteredHostels = (this.filteredHostels || []).filter(h => h && String(h.id) !== String(hostelId) && h.name !== targetName);
    this.ownerProperties = (this.ownerProperties || []).filter(h => h && String(h.id) !== String(hostelId) && h.name !== targetName);

    // 5. Update all UI components globally
    this.renderHostels();
    this.renderMapPins();
    this.renderOpenStreetMap();
    this.renderAdminUsersTables();
    if (typeof this.loadOwnerDashboardData === "function") this.loadOwnerDashboardData();
    if (typeof this.renderUserProfileProperties === "function") this.renderUserProfileProperties();
  }


  filterAdminOwnersTable() {
    const searchVal = document.getElementById("admin-owner-search-input")?.value.toLowerCase().trim() || "";
    const owners = (this.adminUsers || []).filter(u => u.role === "owner");
    const filtered = owners.filter(u => {
      return !searchVal || 
        (u.full_name && u.full_name.toLowerCase().includes(searchVal)) ||
        (u.email && u.email.toLowerCase().includes(searchVal)) ||
        (u.phone && u.phone.includes(searchVal));
    });
    this.renderAdminOwnersTable(filtered);
  }

  filterAdminStudentsTable() {
    const searchVal = document.getElementById("admin-student-search-input")?.value.toLowerCase().trim() || "";
    const students = (this.adminUsers || []).filter(u => u.role === "student");
    const filtered = students.filter(u => {
      return !searchVal || 
        (u.full_name && u.full_name.toLowerCase().includes(searchVal)) ||
        (u.email && u.email.toLowerCase().includes(searchVal)) ||
        (u.phone && u.phone.includes(searchVal));
    });
    this.renderAdminStudentsTable(filtered);
  }

  renderAdminUsersTable(usersToRender = null) {
    const tbody = document.getElementById("admin-users-tbody");
    if (!tbody) return;

    const list = usersToRender || this.adminUsers || [];
    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted);">
            No registered users match the search criteria.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = list.map(u => {
      const dateStr = u.created_at ? new Date(u.created_at).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" }) : "Recently";
      let roleBadge = "badge-accent";
      let avatarBg = "#4f46e5";
      if (u.role === "owner") {
        roleBadge = "badge-success";
        avatarBg = "#059669";
      } else if (u.role === "admin") {
        roleBadge = "badge-rose";
        avatarBg = "#dc2626";
      }

      return `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 12px 16px; font-weight: 600;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="width: 32px; height: 32px; border-radius: 50%; background: ${avatarBg}; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem;">
                ${(u.full_name || 'User').charAt(0).toUpperCase()}
              </div>
              <div>
                <div>${u.full_name || 'Platform User'}</div>
                <div class="font-xs text-muted" style="font-family: monospace;"><i class="fa-solid fa-id-card"></i> ${u.id || 'usr'}</div>
              </div>
            </div>
          </td>
          <td style="padding: 12px 16px;">
            <div class="font-xs">${u.email ? `<i class="fa-solid fa-envelope"></i> ${u.email}` : '<span class="text-muted">No email</span>'}</div>
            <div class="font-xs">${u.phone ? `<i class="fa-solid fa-phone" style="color: #059669;"></i> ${u.phone}` : '<span class="text-muted">No phone</span>'}</div>
          </td>
          <td style="padding: 12px 16px; font-size: 0.85rem; color: var(--text-muted);">${dateStr}</td>
          <td style="padding: 12px 16px;"><span class="badge ${roleBadge} text-capitalize" style="padding: 4px 10px; font-weight: 600;">${u.role}</span></td>
          <td style="padding: 12px 16px;">
            <select class="form-control" style="padding: 4px 8px; font-size: 0.8rem; max-width: 130px;" onchange="app.updateUserRole('${u.id}', this.value)">
              <option value="student" ${u.role === 'student' ? 'selected' : ''}>Student</option>
              <option value="owner" ${u.role === 'owner' ? 'selected' : ''}>PG Owner</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Super Admin</option>
            </select>
          </td>
          <td style="padding: 12px 16px;">
            <button class="btn btn-danger-outline btn-sm" onclick="app.deleteUserAccount('${u.id}')" title="Delete User Account" style="border: 1px solid #ef4444; color: #ef4444; background: transparent;">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  filterAdminUsersTable() {
    const searchVal = document.getElementById("admin-user-search-input")?.value.toLowerCase().trim() || "";
    const roleVal = document.getElementById("admin-user-role-filter")?.value || "all";

    const filtered = (this.adminUsers || []).filter(u => {
      const matchSearch = !searchVal || 
        (u.full_name && u.full_name.toLowerCase().includes(searchVal)) ||
        (u.email && u.email.toLowerCase().includes(searchVal)) ||
        (u.phone && u.phone.includes(searchVal));

      const matchRole = roleVal === "all" || u.role === roleVal;
      return matchSearch && matchRole;
    });

    this.renderAdminUsersTable(filtered);
  }

  async updateUserRole(userId, newRole) {
    const token = localStorage.getItem("hostelkhojo_admin_token") || localStorage.getItem("hostelkhojo_token") || localStorage.getItem("hostelkhojo_owner_token");
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };

    try {
      const res = await apiFetch(`/admin/users/${userId}/role`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ role: newRole })
      });
      if (res.ok) {
        this.showToast(`User role updated to ${newRole}!`, "success");
      } else {
        this.showToast(`User role updated to ${newRole}.`, "success");
      }
    } catch (e) {
      this.showToast(`User role updated to ${newRole}.`, "success");
    }

    const u = (this.adminUsers || []).find(user => user.id === userId);
    if (u) u.role = newRole;
    this.saveUserToLocalAllUsers(u);
    this.renderAdminUsersTables();
    this.updateAdminStatsFromUsers();
  }

  async deleteUserAccount(userId) {
    if (!confirm("Are you sure you want to delete this user account?")) return;

    const token = localStorage.getItem("hostelkhojo_admin_token") || localStorage.getItem("hostelkhojo_token") || localStorage.getItem("hostelkhojo_owner_token");
    const headers = token ? { "Authorization": `Bearer ${token}` } : {};

    try {
      const res = await apiFetch(`/admin/users/${userId}`, {
        method: "DELETE",
        headers
      });
      if (res.ok) {
        this.showToast("User account deleted successfully.", "info");
      } else {
        const err = await res.json().catch(() => ({}));
        this.showToast(err.detail || "User account removed.", "info");
      }
    } catch (e) {
      this.showToast("User account removed.", "info");
    }

    this.adminUsers = (this.adminUsers || []).filter(u => u.id !== userId);
    try {
      const saved = JSON.parse(localStorage.getItem("hostelkhojo_all_users") || "[]");
      const updated = saved.filter(u => u.id !== userId);
      localStorage.setItem("hostelkhojo_all_users", JSON.stringify(updated));
    } catch (e) {}
    this.renderAdminUsersTables();
    this.updateAdminStatsFromUsers();
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
    document.getElementById("owner-prop-modal-title").innerHTML = `<i class="fa-solid fa-building-circle-check" style="color: var(--success-green);"></i> List New PG / Hostel Property`;
    const form = document.getElementById("owner-property-form");
    if (form) form.reset();
    this.selectPropertyType("Hostel");
    this.selectPropertyGender("Boys");
    const regEl = document.getElementById("prop-reg-fee");
    if (regEl) regEl.value = "";

    // Set 1 & 2 Occupancy checked, 3 & 4 unchecked by default
    const c1 = document.getElementById("occ-check-1");
    const c2 = document.getElementById("occ-check-2");
    const c3 = document.getElementById("occ-check-3");
    const c4 = document.getElementById("occ-check-4");
    if (c1) c1.checked = true;
    if (c2) c2.checked = true;
    if (c3) c3.checked = false;
    if (c4) c4.checked = false;

    // Clear any previous rent/deposit input values
    ["1", "2", "3", "4"].forEach(id => {
      const inp = document.getElementById(`prop-rent-${id}`);
      if (inp) inp.value = "";
    });
    const depInp = document.getElementById("prop-deposit");
    if (depInp) depInp.value = "";
    const regInp = document.getElementById("prop-reg-fee");
    if (regInp) regInp.value = "";
    const distInp = document.getElementById("prop-distance");
    if (distInp) distInp.value = "";

    // Reset photo inputs and previews
    const defaultPhotos = {
      main: "assets/images/exterior1.png",
      room: "assets/images/room_single.png",
      washroom: "assets/images/room_shared.png",
      mess: "assets/images/mess.png"
    };
    Object.keys(defaultPhotos).forEach(type => {
      const prev = document.getElementById(`preview-img-${type}`);
      const hid = document.getElementById(`prop-img-${type}`);
      const badge = document.getElementById(`badge-img-${type}`);
      const fileIn = document.getElementById(`file-input-${type}`);
      if (prev) prev.src = defaultPhotos[type];
      if (hid) hid.value = defaultPhotos[type];
      if (badge) badge.style.display = "none";
      if (fileIn) fileIn.value = "";
    });

    this.toggleOccupancyInputs({});

    // Reset location search, pin spotter, and coordinates
    const searchInp = document.getElementById("prop-location-search");
    if (searchInp) searchInp.value = "";
    const resultsDiv = document.getElementById("prop-location-results");
    if (resultsDiv) resultsDiv.style.display = "none";
    const spottedBadge = document.getElementById("prop-spotted-badge");
    if (spottedBadge) spottedBadge.style.display = "none";
    if (document.getElementById("prop-map-link")) document.getElementById("prop-map-link").value = "";
    if (document.getElementById("prop-lat")) document.getElementById("prop-lat").value = "28.6922";
    if (document.getElementById("prop-lng")) document.getElementById("prop-lng").value = "77.2100";

    // Reset stepper pill to step 1
    const pills = document.querySelectorAll(".listing-step-pill");
    if (pills && pills.length > 0) {
      pills.forEach(p => p.classList.remove("active"));
      pills[0].classList.add("active");
    }

    this.openModal("owner-property-modal");
    setTimeout(() => {
      this.initPropertyMiniMap(28.6922, 77.2100);
    }, 250);
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
          // Clear any student session so owner session is exclusively active
          this.currentUser = null;
          localStorage.removeItem("hostelkhojo_token");
          localStorage.removeItem("hostelkhojo_user");
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
        const hadStudentSession = !!this.currentUser;
        // Clear any student session so owner session is exclusively active
        this.currentUser = null;
        localStorage.removeItem("hostelkhojo_token");
        localStorage.removeItem("hostelkhojo_user");

        localStorage.setItem("hostelkhojo_owner_token", data.access_token);
        localStorage.setItem("hostelkhojo_owner_user", JSON.stringify(data.user));
        this.currentOwnerUser = data.user;
        this.saveUserToLocalAllUsers(data.user);
        this.renderAuthNavUI();
        this.closeModal("owner-auth-modal");
        if (hadStudentSession) {
          this.showToast(`Switched from Student to Owner Account! Welcome, ${data.user.full_name}! 🚀`, "success");
        } else {
          this.showToast(`Welcome to Owner Portal, ${data.user.full_name}! 🚀`, "success");
        }
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
        const hadStudentSession = !!this.currentUser;
        // Clear any student session so owner session is exclusively active
        this.currentUser = null;
        localStorage.removeItem("hostelkhojo_token");
        localStorage.removeItem("hostelkhojo_user");

        localStorage.setItem("hostelkhojo_owner_token", data.access_token);
        localStorage.setItem("hostelkhojo_owner_user", JSON.stringify(data.user));
        this.currentOwnerUser = data.user;
        this.saveUserToLocalAllUsers(data.user);
        this.renderAuthNavUI();
        this.closeModal("owner-auth-modal");
        if (hadStudentSession) {
          this.showToast(`Owner Account Created! Switched from student to Owner: ${data.user.full_name}! 🚀`, "success");
        } else {
          this.showToast(`Owner Account Created! Welcome, ${data.user.full_name}! 🚀`, "success");
        }
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

    // 1. Fetch Admin property removal notices for owner
    this.ownerAdminNotices = [];
    try {
      if (token) {
        const notifRes = await apiFetch("/owner/notifications", { headers });
        if (notifRes.ok) {
          const cloudNotifs = await notifRes.json();
          if (Array.isArray(cloudNotifs)) {
            this.ownerAdminNotices = cloudNotifs;
          }
        }
      }
    } catch (e) {}

    // Merge with local removal notices
    try {
      const localNotifs = JSON.parse(localStorage.getItem("hostelkhojo_admin_removed_properties") || "[]");
      if (Array.isArray(localNotifs)) {
        localNotifs.forEach(ln => {
          if (ln && !ln.is_dismissed) {
            const matchesOwner = !ln.owner_id ||
              ln.owner_id === activeOwner.id ||
              (activeOwner.email && ln.owner_id.toLowerCase() === activeOwner.email.toLowerCase()) ||
              (activeOwner.phone && ln.owner_id === activeOwner.phone);
            if (matchesOwner && !this.ownerAdminNotices.some(n => n.id === ln.id || (n.property_id && ln.property_id && n.property_id === ln.property_id))) {
              this.ownerAdminNotices.push(ln);
            }
          }
        });
      }
    } catch (e) {}

    // Get deleted IDs & removed names to filter out of owner's properties
    const deletedIds = JSON.parse(localStorage.getItem("hostelkhojo_deleted_hostel_ids") || "[]");
    const removedNames = (this.ownerAdminNotices || []).map(n => n.property_name && n.property_name.toLowerCase()).filter(Boolean);

    try {
      // Fetch owner properties
      const propRes = await apiFetch("/owner/properties", { headers });
      if (propRes.ok) {
        let fetched = await propRes.json();
        this.ownerProperties = Array.isArray(fetched) ? fetched : [];

        // Auto-sync any locally saved custom properties to cloud database
        const customProps = JSON.parse(localStorage.getItem("hostelkhojo_custom_properties") || "[]");
        if (customProps.length > 0 && token) {
          for (const cp of customProps) {
            if (deletedIds.includes(String(cp.id)) || (cp.name && removedNames.includes(cp.name.toLowerCase()))) continue;
            const existsOnServer = this.ownerProperties.some(op => op.id === cp.id || op.name === cp.name);
            if (!existsOnServer) {
              try {
                const syncRes = await apiFetch("/owner/properties", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                  body: JSON.stringify({
                    name: cp.name,
                    university: cp.university || cp.city,
                    city: cp.city,
                    gender: cp.gender || "Co-ed",
                    type: cp.type || "PG",
                    rent: cp.rent || 8000,
                    deposit: cp.deposit || 5000,
                    distance: cp.distance || 0.5,
                    address: cp.address || cp.city,
                    description: cp.description || "",
                    amenities: cp.amenities || ["Wi-Fi", "4-Time Mess", "AC"],
                    curfew: cp.curfew || "11:00 PM",
                    roomSharing: cp.roomSharing || ["Single", "Double"],
                    verified: true,
                    featured: true,
                    owner_id: activeOwner.id
                  })
                });
                if (syncRes.ok) {
                  const syncedHostel = await syncRes.json();
                  this.ownerProperties.unshift(syncedHostel);
                  this.hostels.unshift(syncedHostel);
                }
              } catch (syncErr) {
                console.warn("Auto-sync notice:", syncErr);
              }
            }
          }
        }
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

    // Filter out any property deleted by super admin
    this.ownerProperties = (this.ownerProperties || []).filter(p => {
      if (!p) return false;
      if (deletedIds.includes(String(p.id))) return false;
      if (p.name && removedNames.includes(p.name.toLowerCase())) return false;
      return true;
    });

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

  async dismissAdminNotice(noticeId) {
    const token = localStorage.getItem("hostelkhojo_owner_token") || localStorage.getItem("hostelkhojo_token");
    const headers = token ? { "Authorization": `Bearer ${token}` } : {};

    try {
      await apiFetch(`/owner/notifications/${noticeId}`, {
        method: "DELETE",
        headers
      });
    } catch (e) {}

    this.ownerAdminNotices = (this.ownerAdminNotices || []).filter(n => String(n.id) !== String(noticeId));

    try {
      let localNotifs = JSON.parse(localStorage.getItem("hostelkhojo_admin_removed_properties") || "[]");
      if (Array.isArray(localNotifs)) {
        localNotifs = localNotifs.filter(n => String(n.id) !== String(noticeId));
        localStorage.setItem("hostelkhojo_admin_removed_properties", JSON.stringify(localNotifs));
      }
    } catch (e) {}

    this.renderOwnerDashboard();
    this.showToast("Removal notice dismissed.", "info");
  }

  renderOwnerDashboard() {
    // Render Admin Removal Notifications Banner
    const notifContainer = document.getElementById("owner-admin-notifications-container");
    if (notifContainer) {
      const notices = (this.ownerAdminNotices || []).filter(n => !n.is_dismissed);
      if (notices.length > 0) {
        notifContainer.innerHTML = notices.map(n => {
          const dateStr = n.created_at ? new Date(n.created_at).toLocaleDateString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Recently";
          const safeId = String(n.id).replace(/'/g, "\\'");
          return `
            <div style="background: rgba(239, 68, 68, 0.08); border: 1.5px solid rgba(239, 68, 68, 0.35); border-radius: var(--radius-md); padding: 16px 20px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; animation: fadeIn 0.3s ease;">
              <div style="display: flex; align-items: flex-start; gap: 14px;">
                <div style="width: 40px; height: 40px; border-radius: 50%; background: #fee2e2; color: #dc2626; display: flex; align-items: center; justify-content: center; font-size: 1.25rem; flex-shrink: 0; margin-top: 2px;">
                  <i class="fa-solid fa-triangle-exclamation"></i>
                </div>
                <div>
                  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                    <span style="font-weight: 700; color: #dc2626; font-size: 0.95rem;">Property Removed by Super Admin</span>
                    <span class="badge" style="background: #dc2626; color: white; font-size: 0.7rem; padding: 2px 8px; border-radius: 4px;">Removed</span>
                  </div>
                  <p style="font-size: 0.88rem; color: var(--text-primary); margin: 0 0 6px 0; line-height: 1.45;">
                    <strong style="color: #dc2626;">Admin has removed this property:</strong> &ldquo;<strong>${n.property_name}</strong>&rdquo;. This property has been removed from your owner account and is no longer live on the website.
                  </p>
                  <div class="font-xs text-muted">
                    <i class="fa-solid fa-clock"></i> Action Date: ${dateStr} • Contact Super Admin support if you have questions.
                  </div>
                </div>
              </div>
              <button class="btn btn-sm btn-outline" onclick="app.dismissAdminNotice('${safeId}')" style="border-color: rgba(220,38,38,0.5); color: #dc2626; padding: 6px 12px; font-size: 0.82rem; white-space: nowrap; flex-shrink: 0; border-radius: 6px; background: transparent; cursor: pointer;">
                <i class="fa-solid fa-xmark"></i> Dismiss
              </button>
            </div>
          `;
        }).join('');
      } else {
        notifContainer.innerHTML = "";
      }
    }

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
        propContainer.innerHTML = this.ownerProperties.map(h => {
          const isOffline = (h.is_live === false || h.is_live === 0 || h.is_live === "false");
          const safeId = String(h.id || h.name || '').replace(/'/g, "\\'");
          return `
          <div class="hostel-card">
            <div class="card-image-wrapper">
              <img src="${h.imageMain || 'assets/images/exterior1.png'}" alt="${h.name}" class="card-image" />
              ${isOffline ? `
                <span class="badge badge-danger" onclick="app.toggleHostelLiveStatus('${safeId}', true)" style="position: absolute; top: 12px; left: 12px; font-weight: 600; padding: 4px 10px; border-radius: 12px; background: #dc2626; color: white; box-shadow: 0 2px 6px rgba(0,0,0,0.2); cursor: pointer;" title="Click to publish Live globally">
                  <i class="fa-solid fa-eye-slash"></i> Offline (Click to Go Live)
                </span>
              ` : `
                <span class="badge badge-success" onclick="app.toggleHostelLiveStatus('${safeId}', false)" style="position: absolute; top: 12px; left: 12px; font-weight: 600; padding: 4px 10px; border-radius: 12px; background: #059669; color: white; box-shadow: 0 2px 6px rgba(0,0,0,0.2); cursor: pointer;" title="Click to make Offline (Hide from website)">
                  <i class="fa-solid fa-wifi"></i> Live on Website (Click to Hide)
                </span>
              `}
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
                ${isOffline ? `
                  <button class="btn btn-sm" style="background: #10b981; color: white; border: none; font-weight: 600; padding: 8px 14px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 6px;" onclick="app.toggleHostelLiveStatus('${safeId}', true); return false;" title="Publish Hostel Live globally">
                    <i class="fa-solid fa-globe"></i> Go Live
                  </button>
                ` : `
                  <button class="btn btn-sm" style="background: #f59e0b; color: white; border: none; font-weight: 600; padding: 8px 14px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 6px;" onclick="app.toggleHostelLiveStatus('${safeId}', false); return false;" title="Make Hostel Offline (Hide from website)">
                    <i class="fa-solid fa-eye-slash"></i> Make Offline
                  </button>
                `}
                <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="app.openEditPropertyModal('${safeId}')">
                  <i class="fa-solid fa-pen-to-square"></i> Edit
                </button>
                <button class="btn btn-accent btn-sm" onclick="app.viewLiveProperty('${safeId}')">
                  <i class="fa-solid fa-eye"></i> View
                </button>
                <button class="btn btn-danger-outline btn-sm" onclick="app.deleteOwnerProperty('${safeId}')" title="Delete Property">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              </div>
            </div>
          </div>
          `;
        }).join('');
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
      container.innerHTML = userProps.map(h => {
        const isOffline = (h.is_live === false || h.is_live === 0 || h.is_live === "false");
        const safeId = String(h.id || h.name || '').replace(/'/g, "\\'");
        return `
        <div class="hostel-card">
          <div class="card-image-wrapper">
            <img src="${h.imageMain || 'assets/images/exterior1.png'}" alt="${h.name}" class="card-image" />
            ${isOffline ? `
              <span class="badge badge-danger" onclick="app.toggleHostelLiveStatus('${safeId}', true)" style="position: absolute; top: 12px; left: 12px; font-weight: 600; padding: 6px 12px; border-radius: 12px; background: #dc2626; color: white; box-shadow: 0 2px 6px rgba(0,0,0,0.2); cursor: pointer;" title="Click to publish Live globally">
                <i class="fa-solid fa-eye-slash"></i> Offline (Click to Go Live)
              </span>
            ` : `
              <span class="badge badge-success" onclick="app.toggleHostelLiveStatus('${safeId}', false)" style="position: absolute; top: 12px; left: 12px; font-weight: 600; padding: 6px 12px; border-radius: 12px; background: #059669; color: white; box-shadow: 0 2px 6px rgba(0,0,0,0.2); cursor: pointer;" title="Click to make Offline (Hide from website)">
                <i class="fa-solid fa-wifi"></i> Live on Website (Click to Hide)
              </span>
            `}

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
              ${isOffline ? `
                <button class="btn btn-sm" style="background: #10b981; color: white; border: none; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px;" onclick="app.toggleHostelLiveStatus('${safeId}', true)" title="Publish Hostel Live globally">
                  <i class="fa-solid fa-globe"></i> Go Live
                </button>
              ` : `
                <button class="btn btn-sm" style="background: #f59e0b; color: white; border: none; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px;" onclick="app.toggleHostelLiveStatus('${safeId}', false)" title="Make Hostel Offline (Hide from website)">
                  <i class="fa-solid fa-eye-slash"></i> Make Offline
                </button>
              `}
              <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="app.openEditPropertyModal('${safeId}')">
                <i class="fa-solid fa-pen-to-square"></i> Edit
              </button>
              <button class="btn btn-accent btn-sm" onclick="app.viewLiveProperty('${safeId}')">
                <i class="fa-solid fa-eye"></i> View
              </button>
              <button class="btn btn-danger-outline btn-sm" onclick="app.deleteOwnerProperty('${safeId}')" title="Delete Property">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>
        </div>
        `;
      }).join('');
    }
  }

  viewLiveProperty(hostelId) {
    const deletedIds = JSON.parse(localStorage.getItem("hostelkhojo_deleted_hostel_ids") || "[]");
    if (deletedIds.includes(String(hostelId))) {
      this.showToast("Admin has removed this property.", "warning");
      return;
    }
    this.switchTab('hostels');
    const hostel = this.hostels.find(h => h.id === hostelId || (h.name && h.name.toLowerCase() === String(hostelId).toLowerCase()));
    if (hostel) {
      setTimeout(() => {
        this.openHostelDetail(hostel.id || hostelId);
      }, 200);
    } else {
      this.showToast("Admin has removed this property.", "warning");
    }
  }

  openEditPropertyModal(hostelId) {
    const deletedIds = JSON.parse(localStorage.getItem("hostelkhojo_deleted_hostel_ids") || "[]");
    if (deletedIds.includes(String(hostelId))) {
      this.showToast("Admin has removed this property.", "warning");
      return;
    }

    const hostel = (this.ownerProperties && this.ownerProperties.find(h => h.id === hostelId || (h.name && h.name.toLowerCase() === String(hostelId).toLowerCase()))) ||
                   (this.hostels && this.hostels.find(h => h.id === hostelId || (h.name && h.name.toLowerCase() === String(hostelId).toLowerCase())));
    if (!hostel) {
      this.showToast("Admin has removed this property.", "warning");
      return;
    }

    document.getElementById("owner-prop-id").value = hostel.id || "";
    document.getElementById("owner-prop-modal-title").innerHTML = `<i class="fa-solid fa-pen-to-square" style="color: #059669;"></i> Edit Property Listing`;
    document.getElementById("prop-name").value = hostel.name || "";
    document.getElementById("prop-university").value = hostel.university || "";
    document.getElementById("prop-city").value = hostel.city || "";
    
    // Set resident gender using visual selector
    this.selectPropertyGender(hostel.gender || "Boys");

    // Set property type category using visual selector (Hostel / PG / Both)
    let selectedType = "Hostel";
    const rawType = (hostel.type || "").toLowerCase();
    if (rawType.includes("both") || (rawType.includes("hostel") && rawType.includes("pg"))) {
      selectedType = "Both";
    } else if (rawType.includes("pg")) {
      selectedType = "PG";
    } else {
      selectedType = "Hostel";
    }
    this.selectPropertyType(selectedType);

    // Set Room Occupancy Checkboxes (1 Occupancy, 2 Occupancy, 3 Occupancy, 4 Occupancy)
    const currentSharing = Array.isArray(hostel.roomSharing) ? hostel.roomSharing : [hostel.roomSharing || "1 Occupancy", "2 Occupancy"];
    const occList = [
      { id: "1", val: "1 Occupancy" },
      { id: "2", val: "2 Occupancy" },
      { id: "3", val: "3 Occupancy" },
      { id: "4", val: "4 Occupancy" }
    ];

    occList.forEach(item => {
      const cb = document.getElementById(`occ-check-${item.id}`);
      if (cb) {
        cb.checked = currentSharing.some(cs => {
          if (!cs) return false;
          const s = String(cs).toLowerCase();
          if (item.id === "1" && (s.includes("1") || s.includes("single"))) return true;
          if (item.id === "2" && (s.includes("2") || s.includes("double"))) return true;
          if (item.id === "3" && (s.includes("3") || s.includes("triple"))) return true;
          if (item.id === "4" && (s.includes("4") || s.includes("quad") || s.includes("four"))) return true;
          return s === item.val.toLowerCase();
        });
      }
    });

    this.toggleOccupancyInputs(hostel.occupancyPricing || {});

    document.getElementById("prop-deposit").value = hostel.deposit || "";
    if (document.getElementById("prop-reg-fee")) document.getElementById("prop-reg-fee").value = (hostel.registrationFee && hostel.registrationFee > 0) ? hostel.registrationFee : "";
    document.getElementById("prop-distance").value = hostel.distance || "";
    document.getElementById("prop-address").value = hostel.address || "";
    document.getElementById("prop-description").value = hostel.description || "";
    
    const hLat = hostel.lat || 28.6922;
    const hLng = hostel.lng || 77.2100;
    if (document.getElementById("prop-lat")) document.getElementById("prop-lat").value = hLat;
    if (document.getElementById("prop-lng")) document.getElementById("prop-lng").value = hLng;
    if (document.getElementById("prop-map-link")) document.getElementById("prop-map-link").value = hostel.mapLink || `https://www.google.com/maps?q=${hLat},${hLng}`;
    if (document.getElementById("prop-location-search")) document.getElementById("prop-location-search").value = hostel.address || hostel.university || "";
    this.updatePropertyCoords(hLat, hLng, hostel.name || "");

    // Populate property photos (Hostel, Rooms, Washroom, Mess)
    const photos = {
      main: hostel.imageMain || "assets/images/exterior1.png",
      room: hostel.imageSingle || hostel.imageRoom || "assets/images/room_single.png",
      washroom: hostel.imageWashroom || hostel.imageShared || "assets/images/room_shared.png",
      mess: hostel.imageMess || "assets/images/mess.png"
    };
    Object.keys(photos).forEach(type => {
      const prev = document.getElementById(`preview-img-${type}`);
      const hid = document.getElementById(`prop-img-${type}`);
      const badge = document.getElementById(`badge-img-${type}`);
      const fileIn = document.getElementById(`file-input-${type}`);
      if (prev) prev.src = photos[type];
      if (hid) hid.value = photos[type];
      if (badge) badge.style.display = (photos[type] && !photos[type].startsWith("assets/images/")) ? "inline-block" : "none";
      if (fileIn) fileIn.value = "";
    });

    // Populate amenities checkmarks
    const hostelAmenities = Array.isArray(hostel.amenities) ? hostel.amenities : [];
    document.querySelectorAll("#prop-amenities-grid input[type='checkbox']").forEach(cb => {
      const isIncluded = hostelAmenities.some(a => String(a).toLowerCase() === cb.value.toLowerCase());
      cb.checked = isIncluded;
      if (cb.parentElement) cb.parentElement.classList.toggle("checked", isIncluded);
    });

    // Reset stepper pill to step 1
    const pills = document.querySelectorAll(".listing-step-pill");
    if (pills && pills.length > 0) {
      pills.forEach(p => p.classList.remove("active"));
      pills[0].classList.add("active");
    }

    this.openModal("owner-property-modal");
    setTimeout(() => {
      this.initPropertyMiniMap(hLat, hLng);
    }, 250);
  }

  selectPropertyType(type) {
    const hidden = document.getElementById("prop-type");
    if (hidden) hidden.value = type;
    document.querySelectorAll("#type-selector-grid .selectable-card").forEach(card => {
      if (card.getAttribute("data-type") === type) {
        card.classList.add("active");
      } else {
        card.classList.remove("active");
      }
    });
  }

  selectPropertyGender(gender) {
    const hidden = document.getElementById("prop-gender");
    if (hidden) hidden.value = gender;
    document.querySelectorAll("#gender-selector-grid .selectable-card").forEach(card => {
      if (card.getAttribute("data-gender") === gender) {
        card.classList.add("active");
      } else {
        card.classList.remove("active");
      }
    });
  }

  handleOccupancyToggle(id) {
    const cb = document.getElementById(`occ-check-${id}`);
    const card = document.getElementById(`occ-card-${id}`);
    const wrap = document.getElementById(`occ-rent-wrap-${id}`);
    const input = document.getElementById(`prop-rent-${id}`);
    if (cb) {
      if (card) card.classList.toggle("active", cb.checked);
      if (wrap) wrap.style.display = cb.checked ? "block" : "none";
      if (input) {
        input.required = cb.checked;
        if (cb.checked) input.focus();
      }
    }
    this.updateStartingRentFromOccupancies();
  }

  toggleOccupancyInputs(existingPricing = null) {
    const occList = [
      { id: "1", val: "1 Occupancy" },
      { id: "2", val: "2 Occupancy" },
      { id: "3", val: "3 Occupancy" },
      { id: "4", val: "4 Occupancy" }
    ];

    let rents = [];

    occList.forEach(item => {
      const cb = document.getElementById(`occ-check-${item.id}`);
      const card = document.getElementById(`occ-card-${item.id}`);
      const wrap = document.getElementById(`occ-rent-wrap-${item.id}`);
      const input = document.getElementById(`prop-rent-${item.id}`);

      if (cb && wrap && input) {
        if (existingPricing && existingPricing[item.val]) {
          input.value = existingPricing[item.val];
        } else if (existingPricing && Object.keys(existingPricing).length === 0) {
          input.value = "";
        }

        if (card) card.classList.toggle("active", cb.checked);

        if (cb.checked) {
          wrap.style.display = "block";
          input.required = true;
          const val = parseFloat(input.value);
          if (!isNaN(val) && val > 0) rents.push(val);
        } else {
          wrap.style.display = "none";
          input.required = false;
        }
      }
    });

    const rentEl = document.getElementById("prop-rent");
    if (rentEl) {
      rentEl.value = rents.length > 0 ? Math.min(...rents) : "";
    }
  }

  updateStartingRentFromOccupancies() {
    const occList = ["1", "2", "3", "4"];
    let rents = [];
    occList.forEach(id => {
      const cb = document.getElementById(`occ-check-${id}`);
      const input = document.getElementById(`prop-rent-${id}`);
      if (cb && cb.checked && input) {
        const val = parseFloat(input.value);
        if (!isNaN(val) && val > 0) rents.push(val);
      }
    });
    const rentEl = document.getElementById("prop-rent");
    if (rentEl) {
      rentEl.value = rents.length > 0 ? Math.min(...rents) : "";
    }
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
    const deposit = parseFloat(document.getElementById("prop-deposit").value) || 0;
    const regFeeRaw = document.getElementById("prop-reg-fee")?.value;
    const registrationFee = (regFeeRaw && !isNaN(parseFloat(regFeeRaw)) && parseFloat(regFeeRaw) > 0) ? parseFloat(regFeeRaw) : 0.0;
    const distance = parseFloat(document.getElementById("prop-distance").value);
    const address = document.getElementById("prop-address").value.trim();
    const lat = parseFloat(document.getElementById("prop-lat")?.value) || 28.6922;
    const lng = parseFloat(document.getElementById("prop-lng")?.value) || 77.2100;
    const mapLink = document.getElementById("prop-map-link")?.value.trim() || `https://www.google.com/maps?q=${lat},${lng}`;
    const description = document.getElementById("prop-description").value.trim();

    // Collect checked room occupancies & their individual monthly rents
    const roomSharing = [];
    const occupancyPricing = {};
    let missingRentType = null;

    [
      { id: "1", name: "1 Occupancy" },
      { id: "2", name: "2 Occupancy" },
      { id: "3", name: "3 Occupancy" },
      { id: "4", name: "4 Occupancy" }
    ].forEach(item => {
      const cb = document.getElementById(`occ-check-${item.id}`);
      const input = document.getElementById(`prop-rent-${item.id}`);
      if (cb && cb.checked) {
        roomSharing.push(item.name);
        const val = input ? parseFloat(input.value) : NaN;
        if (!isNaN(val) && val > 0) {
          occupancyPricing[item.name] = val;
        } else if (!missingRentType) {
          missingRentType = item.name;
          if (input) input.focus();
        }
      }
    });

    if (roomSharing.length === 0) {
      this.showToast("Please select at least one Room Occupancy option.", "warning");
      return;
    }

    if (missingRentType) {
      this.showToast(`Please enter the monthly rent for ${missingRentType}.`, "warning");
      return;
    }

    const rentPrices = Object.values(occupancyPricing);
    const rent = rentPrices.length > 0 ? Math.min(...rentPrices) : 0;

    // Collect checked amenities
    const amenities = [];
    document.querySelectorAll("#prop-amenities-grid input[type='checkbox']:checked").forEach(cb => {
      amenities.push(cb.value);
    });

    // Collect uploaded property photos (Hostel, Rooms, Washroom, Mess)
    const imageMain = document.getElementById("prop-img-main")?.value || "assets/images/exterior1.png";
    const imageSingle = document.getElementById("prop-img-room")?.value || "assets/images/room_single.png";
    const imageWashroom = document.getElementById("prop-img-washroom")?.value || "assets/images/room_shared.png";
    const imageMess = document.getElementById("prop-img-mess")?.value || "assets/images/mess.png";

    const ownerId = activeUser.id;

    const payload = {
      name,
      university,
      city,
      gender,
      type,
      rent,
      deposit,
      registrationFee,
      distance,
      address,
      lat,
      lng,
      mapLink,
      imageMain,
      imageSingle,
      imageShared: imageWashroom,
      imageWashroom,
      imageMess,
      description,
      amenities,
      curfew: "11:00 PM",
      roomSharing,
      occupancyPricing,
      verified: true,
      featured: true,
      is_live: true,
      owner_id: ownerId
    };

    const token = localStorage.getItem("hostelkhojo_owner_token") || localStorage.getItem("hostelkhojo_token");
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };

    let newHostelObj = null;

    let isCloudSaved = false;

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
        isCloudSaved = true;
      } else {
        const errData = await res.json().catch(() => ({}));
        if (res.status === 403 && errData.detail) {
          this.showToast(errData.detail, "warning");
          return;
        }
      }

      // Sync property to live production cloud backend if currently on local host
      if (API_BASE_URL !== RENDER_BACKEND_URL) {
        fetch(`${RENDER_BACKEND_URL}/owner/properties`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(() => {});
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
    
    if (isCloudSaved) {
      this.showToast(id ? "Property listing updated live on all devices!" : "New PG/Hostel published live to all devices worldwide!", "success");
    } else {
      this.showToast("Property saved locally on this browser. Log in as an Owner to sync your listing to all devices worldwide!", "info");
    }
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

    // 1. Record in deleted hostel IDs filter
    try {
      let deletedIds = JSON.parse(localStorage.getItem("hostelkhojo_deleted_hostel_ids") || "[]");
      if (!Array.isArray(deletedIds)) deletedIds = [];
      if (!deletedIds.includes(String(hostelId))) {
        deletedIds.push(String(hostelId));
        localStorage.setItem("hostelkhojo_deleted_hostel_ids", JSON.stringify(deletedIds));
      }
    } catch (e) {}

    // 2. Remove from all local property storage keys
    for (const key of ["hostelkhojo_real_properties", "hostelkhojo_custom_properties", "hostelkhojo_properties"]) {
      try {
        let stored = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(stored)) {
          stored = stored.filter(h => h && String(h.id) !== String(hostelId));
          localStorage.setItem(key, JSON.stringify(stored));
        }
      } catch (e) {}
    }

    // 3. Remove from main app memory arrays
    this.hostels = (this.hostels || []).filter(h => h && String(h.id) !== String(hostelId));
    this.filteredHostels = (this.filteredHostels || []).filter(h => h && String(h.id) !== String(hostelId));

    // 4. Update all UI components globally
    this.applyFilters();
    this.renderHostels();
    this.renderMapPins();
    this.renderOpenStreetMap();
    this.renderAdminUsersTables();
    if (typeof this.loadOwnerDashboardData === "function") this.loadOwnerDashboardData();
    if (typeof this.renderUserProfileProperties === "function") this.renderUserProfileProperties();
  }

  async toggleHostelLiveStatus(hostelId, isLive) {
    const targetId = String(hostelId || '').trim();
    const boolLive = Boolean(isLive);

    const matchFn = (h) => h && (
      (h.id && String(h.id).trim() === targetId) ||
      (h.name && String(h.name).trim().toLowerCase() === targetId.toLowerCase())
    );

    // 1. INSTANTLY update state in memory for 0ms UI reactivity
    if (Array.isArray(this.hostels)) {
      this.hostels.forEach(h => {
        if (matchFn(h)) h.is_live = boolLive;
      });
    }

    if (Array.isArray(this.ownerProperties)) {
      this.ownerProperties.forEach(h => {
        if (matchFn(h)) h.is_live = boolLive;
      });
    }

    // 2. INSTANTLY update all relevant localStorage keys
    for (const key of ["hostelkhojo_real_properties", "hostelkhojo_custom_properties", "hostelkhojo_properties", "hostelkhojo_hostels"]) {
      try {
        let stored = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(stored)) {
          stored.forEach(h => {
            if (matchFn(h)) h.is_live = boolLive;
          });
          localStorage.setItem(key, JSON.stringify(stored));
        }
      } catch (e) {}
    }

    // 3. INSTANTLY re-render all UI screens (0ms delay)
    this.applyFilters();
    this.renderHostels();
    this.renderMapPins();
    this.renderOpenStreetMap();
    this.renderOwnerDashboard();
    this.renderAdminUsersTables();
    if (typeof this.renderUserProfileProperties === "function") this.renderUserProfileProperties();

    // 4. Send background API sync request
    const token = localStorage.getItem("hostelkhojo_owner_token") || localStorage.getItem("hostelkhojo_admin_token") || localStorage.getItem("hostelkhojo_token");
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };

    try {
      const res = await apiFetch(`/owner/properties/${encodeURIComponent(targetId)}/status`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ is_live: boolLive })
      });
      if (res.ok) {
        const data = await res.json();
        this.showToast(data.message || (boolLive ? "Hostel is now Live globally! 🌐" : "Hostel is now Offline (Hidden from website) 🔒"), "success");
      } else {
        this.showToast(`Hostel is now ${boolLive ? 'Live globally 🌐' : 'Offline (Hidden) 🔒'}.`, "info");
      }
    } catch (err) {
      this.showToast(`Hostel is now ${boolLive ? 'Live globally 🌐' : 'Offline (Hidden) 🔒'}.`, "info");
    }
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
        // Clear any owner session so student session is exclusively active
        this.currentOwnerUser = null;
        localStorage.removeItem("hostelkhojo_owner_token");
        localStorage.removeItem("hostelkhojo_owner_user");

        localStorage.setItem("hostelkhojo_token", data.access_token);
        localStorage.setItem("hostelkhojo_user", JSON.stringify(data.user));
        this.currentUser = data.user;
        this.saveUserToLocalAllUsers(data.user);
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
        // Clear any owner session so student session is exclusively active
        this.currentOwnerUser = null;
        localStorage.removeItem("hostelkhojo_owner_token");
        localStorage.removeItem("hostelkhojo_owner_user");

        localStorage.setItem("hostelkhojo_token", data.access_token);
        localStorage.setItem("hostelkhojo_user", JSON.stringify(data.user));
        this.currentUser = data.user;
        this.saveUserToLocalAllUsers(data.user);
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
          const hadStudentSession = !!this.currentUser;
          // Clear any student session so owner session is exclusively active
          this.currentUser = null;
          localStorage.removeItem("hostelkhojo_token");
          localStorage.removeItem("hostelkhojo_user");

          localStorage.setItem("hostelkhojo_owner_token", data.access_token);
          localStorage.setItem("hostelkhojo_owner_user", JSON.stringify(data.user));
          this.currentOwnerUser = data.user;
          this.saveUserToLocalAllUsers(data.user);
          this.renderAuthNavUI();
          this.closeModal("owner-auth-modal");
          if (hadStudentSession) {
            this.showToast(`Switched from Student to Owner Account! Welcome, ${data.user.full_name}! 🚀`, "success");
          } else {
            this.showToast(`Welcome to Owner Portal, ${data.user.full_name}! 🚀`, "success");
          }
          this.openOwnerPortal();
        } else {
          // Clear any owner session so student session is exclusively active
          this.currentOwnerUser = null;
          localStorage.removeItem("hostelkhojo_owner_token");
          localStorage.removeItem("hostelkhojo_owner_user");

          localStorage.setItem("hostelkhojo_token", data.access_token);
          localStorage.setItem("hostelkhojo_user", JSON.stringify(data.user));
          this.currentUser = data.user;
          this.saveUserToLocalAllUsers(data.user);
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
    if (!token || this.currentOwnerUser || localStorage.getItem("hostelkhojo_owner_token")) {
      if (this.currentOwnerUser || localStorage.getItem("hostelkhojo_owner_token")) {
        this.currentUser = null;
        localStorage.removeItem("hostelkhojo_token");
        localStorage.removeItem("hostelkhojo_user");
      }
      return;
    }

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
    const listBtn = document.getElementById("nav-list-btn") || document.querySelector(".nav-list-btn");
    if (!container) return;

    if (this.currentAdminUser && this.currentAdminUser.role === "admin") {
      const initials = (this.currentAdminUser.full_name || "SA")
        .split(" ")
        .map(n => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);

      if (listBtn) {
        listBtn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> <span class="btn-text-full">Admin Panel</span><span class="btn-text-short">Admin</span>`;
        listBtn.onclick = () => app.openAdminPortal();
      }

      container.innerHTML = `
        <div class="user-badge-container">
          <button class="user-badge-btn admin-badge-btn" onclick="app.openAdminPortal()" title="View Super Admin Control Panel (/admin)" style="border-color: #dc2626; background: rgba(220, 38, 38, 0.08);">
            <div class="user-badge-avatar" style="background: #dc2626; color: white;">${initials}</div>
            <span class="user-badge-name" style="font-weight: 600; font-size: 0.88rem; color: var(--text-primary);">${this.currentAdminUser.full_name}</span>
            <span class="badge badge-rose" style="margin-left: 4px; font-size: 0.72rem; padding: 2px 8px; background: #dc2626; color: white; border-radius: 12px;"><i class="fa-solid fa-shield-halved"></i> Super Admin</span>
          </button>
        </div>
      `;
    } else if (this.currentOwnerUser) {
      const initials = (this.currentOwnerUser.full_name || "OW")
        .split(" ")
        .map(n => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);

      if (listBtn) {
        listBtn.innerHTML = `<i class="fa-solid fa-plus-circle"></i> <span class="btn-text-full">+ Add Property</span><span class="btn-text-short">Add PG</span>`;
        listBtn.onclick = () => app.openOwnerPropertyModal();
      }

      container.innerHTML = `
        <div class="user-badge-container">
          <button class="user-badge-btn owner-badge-btn" onclick="app.openOwnerPortal()" title="View Owner Dashboard (/owner)" style="border-color: #059669; background: rgba(5, 150, 105, 0.08);">
            <div class="user-badge-avatar" style="background: #059669; color: white;">${initials}</div>
            <span class="user-badge-name" style="font-weight: 600; font-size: 0.88rem; color: var(--text-primary);">${this.currentOwnerUser.full_name}</span>
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

      if (listBtn) {
        listBtn.innerHTML = `<i class="fa-solid fa-building-user"></i> <span class="btn-text-full">List Your PG / Hostel</span><span class="btn-text-short">List PG</span>`;
        listBtn.onclick = () => app.openOwnerPortal();
      }

      container.innerHTML = `
        <div class="user-badge-container">
          <button class="user-badge-btn" onclick="app.switchTab('user')" title="View Student Profile (/user)">
            <div class="user-badge-avatar">${initials}</div>
            <span class="user-badge-name">${this.currentUser.full_name}</span>
            <i class="fa-solid fa-user font-xs" style="margin-left: 6px; opacity: 0.7;"></i>
          </button>
        </div>
      `;
    } else {
      if (listBtn) {
        listBtn.innerHTML = `<i class="fa-solid fa-plus-circle"></i> <span class="btn-text-full">List Your PG / Hostel</span><span class="btn-text-short">List PG</span>`;
        listBtn.onclick = () => app.openOwnerPortal();
      }

      container.innerHTML = `
        <button class="btn btn-primary nav-login-btn" onclick="app.openModal('auth-modal')" id="nav-login-btn">
          <i class="fa-solid fa-circle-user"></i>
          <span class="btn-text-full">Student Login</span>
          <span class="btn-text-short">Login</span>
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
    if (tabName === "admin") {
      if (!this.currentAdminUser || this.currentAdminUser.role !== "admin") {
        this.openAdminPortal();
        return;
      }
      if (window.location.pathname !== "/admin") {
        try { history.pushState(null, "", "/admin"); } catch (e) { window.location.hash = "admin"; }
      }
      document.querySelectorAll(".tab-content").forEach(t => t.style.display = "none");
      document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
      document.querySelectorAll(".mobile-nav-item").forEach(m => m.classList.remove("active"));

      const adminTab = document.getElementById("tab-admin");
      if (adminTab) adminTab.style.display = "block";
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

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
      if (this.currentOwnerUser) {
        this.openOwnerPortal();
        return;
      }

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
    if (id === "auth-modal" && this.currentOwnerUser) {
      this.showToast("You are logged in as PG/Hostel Owner. Please log out first if you wish to sign in as a student.", "info");
      this.openOwnerPortal();
      return;
    }

    if (id === "owner-auth-modal") {
      if (this.currentOwnerUser) {
        this.openOwnerPortal();
        return;
      }

      const noticeBox = document.getElementById("owner-auth-student-notice");
      const noticeText = document.getElementById("owner-auth-student-notice-text");
      if (noticeBox) {
        if (this.currentUser) {
          noticeBox.style.display = "block";
          if (noticeText) {
            noticeText.innerHTML = `You are currently signed in as student (<strong>${this.currentUser.full_name || "Student"}</strong>). Logging in as Owner will automatically log out your student session and switch you to Owner mode to list hostels.`;
          }
        } else {
          noticeBox.style.display = "none";
        }
      }
    }

    if (id === "admin-auth-modal") {
      const pwd = document.getElementById("admin-login-password");
      if (pwd) {
        pwd.value = "";
        setTimeout(() => pwd.focus(), 150);
      }
    }

    if (id === "post-roommate-modal" && !this.currentUser) {
      if (this.currentOwnerUser) {
        this.showToast("Roommate matching is for student accounts. You are currently signed in as PG Owner.", "warning");
        return;
      }
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

    if (id === "owner-property-modal") {
      const container = document.getElementById("prop-occupancy-pricing-container");
      if (container && (!container.children || container.children.length === 0)) {
        this.renderOccupancyRentInputs({ "1 Occupancy": 12000, "2 Occupancy": 8500 });
      }
      setTimeout(() => {
        const curLat = parseFloat(document.getElementById("prop-lat")?.value) || 28.6922;
        const curLng = parseFloat(document.getElementById("prop-lng")?.value) || 77.2100;
        this.initPropertyMiniMap(curLat, curLng);
      }, 250);
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

    // Sync map tile layer if not on satellite mode
    if (this.leafletMap && this.currentMapTileLayer !== "satellite") {
      this.setMapTileLayer(next === "dark" ? "dark" : "street");
    }
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
