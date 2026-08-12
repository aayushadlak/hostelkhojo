/* ==========================================================================
   HOSTEL KHOJO INDIA - APPLICATION ENGINE
   ========================================================================== */

const API_BASE_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://127.0.0.1:8000/api"
  : "/api";


const INITIAL_HOSTELS = [];
const INITIAL_ROOMMATES = [];


class HostelKhojoApp {
  constructor() {
    this.hostels = [...INITIAL_HOSTELS];
    this.filteredHostels = [...INITIAL_HOSTELS];
    this.roommates = [...INITIAL_ROOMMATES];
    
    this.savedIds = JSON.parse(localStorage.getItem("hostelkhojo_saved") || localStorage.getItem("dormify_saved") || "[]");
    this.comparisonIds = [];
    this.activePills = new Set();
    
    this.currentUser = JSON.parse(localStorage.getItem("hostelkhojo_user") || "null");
    this.currentViewMode = "grid"; // 'grid' or 'split'
    this.currentSort = "recommended";
    
    this.init();
  }

  init() {
    this.updateSavedCount();
    this.renderHostels();
    this.renderRoommates();
    this.renderMapPins();
    this.loadBackendData();
    this.checkUserSession();
    this.renderAuthNavUI();
    
    // Check saved theme - default to Light theme
    const savedTheme = localStorage.getItem("hostelkhojo_theme") || localStorage.getItem("dormify_theme") || "light";
    document.documentElement.setAttribute("data-theme", savedTheme);
    this.updateThemeIcon(savedTheme);
  }


  async loadBackendData() {
    try {
      const res = await fetch(`${API_BASE_URL}/hostels`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          this.hostels = data;
          this.filteredHostels = [...data];
          this.renderHostels();
          this.renderMapPins();
        }
      }
    } catch (err) {
      console.log("FastAPI Backend offline, using local mock hostels.");
    }

    try {
      const rmRes = await fetch(`${API_BASE_URL}/roommates`);
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
    this.applyFilters();
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
            <button class="btn btn-accent btn-lg" onclick="app.openModal('owner-modal')">
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
          ₹${(h.rent/1000).toFixed(1)}k
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
                <div class="room-price">₹${(h.rent * (type==='Single'? 1.3 : type==='Double'? 1.0 : 0.8)).toFixed(0)}/mo</div>
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
      const res = await fetch(`${API_BASE_URL}/bookings`, {
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
      const res = await fetch(`${API_BASE_URL}/roommates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const newRm = await res.json();
        this.roommates.unshift(newRm);
        this.renderRoommates();
      } else {
        const fallbackProfile = { ...payload, id: "r_" + Date.now(), sleepHabit, avatar: name.split(' ').map(n=>n[0]).join('').toUpperCase() };
        this.roommates.unshift(fallbackProfile);
        this.renderRoommates();
      }
    } catch (err) {
      const fallbackProfile = { ...payload, id: "r_" + Date.now(), sleepHabit, avatar: name.split(' ').map(n=>n[0]).join('').toUpperCase() };
      this.roommates.unshift(fallbackProfile);
      this.renderRoommates();
    }

    this.closeModal("post-roommate-modal");
    this.showToast("Your roommate requirement card has been published!", "success");
  }

  connectRoommate(name) {
    this.showToast(`Connection request sent to ${name}! Check your student messages.`, "success");
  }

  /* OWNER FORM SUBMISSION */
  async handleOwnerFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const inputs = form.querySelectorAll("input, select, textarea");
    
    const owner_name = inputs[0]?.value || "Property Owner";
    const owner_phone = inputs[1]?.value || "+91 9876543210";
    const property_name = inputs[2]?.value || "Student PG Stay";
    const city = inputs[3]?.value || "New Delhi";
    const address = inputs[4]?.value || "Near College Campus";
    const rooms_count = parseInt(inputs[5]?.value || "10");
    const rent_range = inputs[6]?.value || "₹8,000 - ₹15,000";

    const payload = {
      owner_name,
      owner_phone,
      property_name,
      city,
      address,
      rooms_count,
      rent_range
    };

    try {
      await fetch(`${API_BASE_URL}/owner-submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.log("Submit property fallback");
    }

    this.closeModal("owner-modal");
    this.showToast("Property submitted! Our campus inspection team will verify within 24 hours.", "success");
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
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
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
        this.showToast(`Welcome back, ${data.user.full_name}! Session Active.`, "success");
        return;
      } else {
        const errorData = await res.json().catch(() => ({}));
        this.showToast(errorData.detail || "Invalid login credentials. Please check Phone/Email & password.", "warning");
        return;
      }
    } catch (err) {
      console.log("FastAPI backend offline, using demo fallback session.");
    }

    // Local fallback session
    const fallbackUser = {
      id: "usr_local",
      phone: identifier,
      full_name: identifier.includes("@") ? identifier.split("@")[0].toUpperCase() : "STUDENT USER",
      role: "student"
    };
    localStorage.setItem("hostelkhojo_user", JSON.stringify(fallbackUser));
    this.currentUser = fallbackUser;
    this.renderAuthNavUI();
    this.closeModal("auth-modal");
    this.showToast(`Welcome back, ${fallbackUser.full_name}! User Session active.`, "success");
  }

  async handleStudentRegisterSubmit(e) {
    e.preventDefault();
    const full_name = document.getElementById("reg-name").value.trim();
    const phone = document.getElementById("reg-phone").value.trim();
    const email = document.getElementById("reg-email")?.value.trim() || null;
    const password = document.getElementById("reg-password").value.trim();

    const payload = { full_name, phone, email, password, role: "student" };

    try {
      const res = await fetch(`${API_BASE_URL}/auth/register`, {
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
        this.showToast(errorData.detail || "Registration failed. Phone number might already exist.", "warning");
        return;
      }
    } catch (err) {
      console.log("FastAPI backend offline, using demo fallback registration.");
    }

    // Local fallback
    const fallbackUser = { id: "usr_" + Date.now(), phone, full_name, role: "student" };
    localStorage.setItem("hostelkhojo_user", JSON.stringify(fallbackUser));
    this.currentUser = fallbackUser;
    this.renderAuthNavUI();
    this.closeModal("auth-modal");
    this.showToast(`Account Registered! Welcome ${full_name}!`, "success");
  }

  async checkUserSession() {

    const token = localStorage.getItem("hostelkhojo_token");
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE_URL}/auth/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.ok) {
        const userData = await res.json();
        this.currentUser = userData;
        localStorage.setItem("hostelkhojo_user", JSON.stringify(userData));
        this.renderAuthNavUI();
      }
    } catch (err) {
      console.log("Session verification skipped (offline).");
    }
  }

  renderAuthNavUI() {
    const container = document.getElementById("nav-auth-container");
    if (!container) return;

    if (this.currentUser) {
      const initials = (this.currentUser.full_name || "ST")
        .split(" ")
        .map(n => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);

      container.innerHTML = `
        <div class="user-badge-container">
          <button class="user-badge-btn" onclick="app.logoutUser()" title="Click to Logout (${this.currentUser.email})">
            <div class="user-badge-avatar">${initials}</div>
            <span>${this.currentUser.full_name}</span>
            <i class="fa-solid fa-right-from-bracket font-xs" style="margin-left: 4px; opacity: 0.7;"></i>
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

  logoutUser() {
    localStorage.removeItem("hostelkhojo_token");
    localStorage.removeItem("hostelkhojo_user");
    this.currentUser = null;
    this.renderAuthNavUI();
    this.showToast("Signed out of Student Session.", "info");
  }



  /* GENERAL TAB SWITCHER */
  switchTab(tabName) {
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
    document.querySelectorAll(".mobile-nav-item").forEach(m => m.classList.remove("active"));

    if (tabName === "hostels") {
      document.getElementById("tab-hostels")?.classList.add("active");
      document.getElementById("nav-hostels-btn")?.classList.add("active");
      document.getElementById("mob-nav-hostels")?.classList.add("active");
    } else if (tabName === "roommates") {
      document.getElementById("tab-roommates")?.classList.add("active");
      document.getElementById("nav-roommates-btn")?.classList.add("active");
      document.getElementById("mob-nav-roommates")?.classList.add("active");
    }
  }

  /* MODAL HELPERS */
  openModal(id) {
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
