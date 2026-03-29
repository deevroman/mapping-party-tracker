/* ═══════════════════════════════════════════════════════════════
   Mapping Party Tracker — map.js
   Leaflet map, polygon rendering, claim/score/release, WebSocket
   ═══════════════════════════════════════════════════════════════ */

MPT.initMapPage = (function ($) {
  'use strict';

  // ─── Status → fill color ──────────────────────────────────────────
  const STATUS_COLORS = {
    0: 'transparent',
    1: '#e74c3c',
    2: '#e67e22',
    3: '#f1c40f',
    4: '#2ecc71',
    5: '#27ae60',
  };

  // ─── Module state ─────────────────────────────────────────────────
  let _projectId;
  let _projectTitle = '';
  let _map;
  let _user = null;
  let _polygons = [];          // [{id, status, claimed_by_id, claimed_by_username, layer}]
  let _layerGroup;
  let _openPopupPolygonId = null;
  let _ws = null;
  let _wsReconnectDelay = 1000;
  let _pendingClaimPolygonId = null;  // for post-OAuth claim

  // ─── Init ──────────────────────────────────────────────────────────

  return async function initMapPage(projectId) {
    _projectId = projectId;

    _map = L.map('map', {
      center: [20, 0],
      zoom: 2,
      zoomControl: true,
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(_map);

    _layerGroup = L.layerGroup().addTo(_map);

    // Check for pending claim from URL
    const params = new URLSearchParams(location.search);
    _pendingClaimPolygonId = params.get('claim') ? parseInt(params.get('claim')) : null;

    // Clean URL
    if (_pendingClaimPolygonId || params.has('claim')) {
      history.replaceState({}, '', `/map/${projectId}`);
    }

    // Load user & project in parallel
    const [user, project] = await Promise.all([
      MPT.loadSession(),
      MPT.api.get(`/api/projects/${projectId}`),
    ]);
    _user = user;

    renderSidebar(project);
    await loadPolygons();
    await loadStats();
    connectWebSocket();
    bindSidebarToggle();

    // Handle pending claim from OAuth redirect
    if (_pendingClaimPolygonId) {
      setTimeout(() => attemptClaim(_pendingClaimPolygonId), 500);
    }
  };

  // ─── Sidebar ───────────────────────────────────────────────────────

  function renderSidebar(project) {
    _projectTitle = project.title;
    $('#project-title').text(project.title);
    document.title = project.title + ' — Mapping Party Tracker';

    if (project.link_url) {
      const linkText = project.link_text || project.link_url;
      $('#project-link').attr('href', project.link_url).text(linkText);
      $('#project-link-container').removeAttr('hidden');
    }

    // User bar
    const $userBar = $('#user-bar');
    if (_user && _user.authenticated) {
      $userBar.html(`
        <div class="user-bar-logged-in">
          <span class="user-bar-name">@<strong>${MPT.escHtml(_user.username)}</strong></span>
          <form method="POST" action="/auth/logout" style="margin:0">
            <button type="submit" class="btn btn-sm btn-logout">Logout</button>
          </form>
        </div>
      `);
    } else {
      $userBar.html(`<a href="/auth/login?next=${encodeURIComponent(location.pathname)}" class="btn btn-login btn-sm">Login with OSM</a>`);
    }

    // Owner bar
    if (_user && _user.authenticated && _user.id === project.owner_id) {
      $('#edit-project-link').attr('href', `/edit/${_projectId}`);
      $('#owner-bar').removeAttr('hidden');
    }
  }

  function bindSidebarToggle() {
    $('#sidebar-toggle').on('click', function () {
      $('#sidebar').toggleClass('collapsed');
    });
  }

  // ─── Load & render polygons ────────────────────────────────────────

  async function loadPolygons() {
    let data;
    try {
      data = await MPT.api.get(`/api/projects/${_projectId}/polygons`);
    } catch (e) {
      console.error('Failed to load polygons', e);
      return;
    }

    _polygons = [];
    _layerGroup.clearLayers();

    data.forEach(addPolygon);

    // Fit map to bounds
    if (_polygons.length > 0) {
      const group = L.featureGroup(_polygons.map(p => p.layer));
      try { _map.fitBounds(group.getBounds(), { padding: [20, 20] }); }
      catch (e) { /* bounds error */ }
    }
  }

  function addPolygon(polyData) {
    const feature = polyData.geojson;
    const layer = L.geoJSON(feature, {
      style: () => styleForPolygon(polyData),
    });

    layer.on('click', () => openPolygonPopup(polyData.id));

    layer.addTo(_layerGroup);

    _polygons.push({
      id: polyData.id,
      status: polyData.status,
      claimed_by_id: polyData.claimed_by_id,
      claimed_by_username: polyData.claimed_by_username,
      layer,
    });
  }

  function styleForPolygon(poly) {
    const fillColor = STATUS_COLORS[poly.status] || 'transparent';
    const isMine = _user && _user.authenticated && poly.claimed_by_id === _user.id;
    const isOther = poly.claimed_by_id && !isMine;

    return {
      fillColor: fillColor === 'transparent' ? '#fff' : fillColor,
      fillOpacity: fillColor === 'transparent' ? 0 : 0.5,
      color: isMine ? '#ff4d6d' : isOther ? '#4d9fff' : '#666',
      weight: (isMine || isOther) ? 3 : 1,
      opacity: 1,
    };
  }

  function getPolygon(id) {
    return _polygons.find(p => p.id === id) || null;
  }

  function updatePolygonStyle(id) {
    const poly = getPolygon(id);
    if (!poly) return;
    poly.layer.setStyle(styleForPolygon(poly));
  }

  // ─── Stats ────────────────────────────────────────────────────────

  async function loadStats() {
    try {
      const stats = await MPT.api.get(`/api/projects/${_projectId}/stats`);
      renderStats(stats);
    } catch (e) { /* silent */ }
  }

  function renderStats(stats) {
    $('#stat-total').text(stats.total);
    $('#stat-claimed').text(stats.claimed);
    $('#stat-free').text(Math.max(0, stats.total - stats.claimed));
    renderHistogram(stats.histogram, stats.total);
  }

  function renderHistogram(histogram, total) {
    const $hist = $('#histogram');
    const BAR_MAX_PX = 52;
    const maxVal = Math.max(...Object.values(histogram), 1);
    const colors = STATUS_COLORS;

    $hist.html('<div class="histogram-title">Score Distribution</div>');
    const $bars = $('<div class="histogram-bars"></div>');

    for (let i = 0; i <= 5; i++) {
      const count = histogram[String(i)] || 0;
      const px = Math.round((count / maxVal) * BAR_MAX_PX);
      const barPx = count > 0 ? Math.max(px, 3) : 0;
      const bg = i === 0 ? '#444' : colors[i];
      $bars.append(`
        <div class="histo-bar-wrap" title="Score ${i}: ${count}">
          <span class="histo-count">${count > 0 ? count : ''}</span>
          <div class="histo-bar" style="height:${barPx}px;background:${bg}"></div>
          <span class="histo-label">${i}</span>
        </div>
      `);
    }
    $hist.append($bars);
  }

  // ─── GeoJSON → OSM XML ────────────────────────────────────────────

  function geojsonToOsmXml(feature) {
    const geom = feature.geometry;
    let ring;
    if (geom.type === 'Polygon') {
      ring = geom.coordinates[0];
    } else if (geom.type === 'MultiPolygon') {
      ring = geom.coordinates[0][0];
    } else {
      return null;
    }
    // Drop closing duplicate point if present
    const coords = (ring[0][0] === ring[ring.length-1][0] &&
                    ring[0][1] === ring[ring.length-1][1])
      ? ring.slice(0, -1) : ring.slice();

    const nodes = coords.map(([lon, lat], i) => ({ id: -(i + 1), lat, lon }));

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6">\n';
    nodes.forEach(n => {
      xml += `  <node id="${n.id}" lat="${n.lat}" lon="${n.lon}" version="1"/>\n`;
    });
    xml += `  <way id="-${nodes.length + 1}" version="1">\n`;
    nodes.forEach(n => { xml += `    <nd ref="${n.id}"/>\n`; });
    xml += `    <nd ref="${nodes[0].id}"/>\n`;
    xml += '  </way>\n</osm>';
    return xml;
  }

  function openInJosm(polygonId, projectTitle) {
    const poly = getPolygon(polygonId);
    if (!poly) return;

    const fc = poly.layer.toGeoJSON();
    const feature = fc.type === 'FeatureCollection' ? fc.features[0] : fc;
    const osmXml = geojsonToOsmXml(feature);
    if (!osmXml) { alert('Cannot convert this geometry to OSM XML.'); return; }

    const layerName = encodeURIComponent(`${projectTitle} #${polygonId}`);
    const url = 'http://127.0.0.1:8111/load_data?new_layer=true' +
                '&layer_name=' + layerName +
                '&layer_locked=true' +
                '&download_policy=never' +
                '&upload_policy=never' +
                '&data=' + encodeURIComponent(osmXml);

    let $iframe = $('#josm-iframe');
    if (!$iframe.length) {
      $iframe = $('<iframe id="josm-iframe" style="display:none"></iframe>').appendTo('body');
    }
    $iframe.attr('src', url);
  }

  // ─── Popup ────────────────────────────────────────────────────────

  function openPolygonPopup(polygonId) {
    const poly = getPolygon(polygonId);
    if (!poly) return;

    _openPopupPolygonId = polygonId;

    const bounds = poly.layer.getBounds();
    const center = bounds.getCenter();

    // Build popup content
    const html = buildPopupHtml(poly);

    const popup = L.popup({ maxWidth: 280, className: 'mpt-popup' })
      .setLatLng(center)
      .setContent(html)
      .openOn(_map);

    popup.on('remove', () => { _openPopupPolygonId = null; });

    // Bind buttons after popup opens
    setTimeout(() => {
      bindPopupButtons(polygonId);
    }, 50);
  }

  function buildPopupHtml(poly) {
    const isMine = _user && _user.authenticated && poly.claimed_by_id === _user.id;
    const isOther = poly.claimed_by_id && !isMine;
    const userHasOtherClaim = _user && _user.authenticated && !isMine && hasActiveClaim();

    let body = `<div class="popup-inner">
      <div class="popup-id">Polygon #${poly.id}</div>`;

    if (isOther) {
      // Claimed by someone else
      body += `<div class="popup-claimed-by">Claimed by: <strong>${MPT.escHtml(poly.claimed_by_username)}</strong></div>`;

    } else if (isMine) {
      // Current user's claim
      body += `<div class="popup-score-label">Completeness</div>
      <div class="score-row">`;
      for (let i = 0; i <= 5; i++) {
        const active = poly.status === i ? 'active' : '';
        const msg = i == 0 ? 'TODO' : (i == 5 ? '100%' : '' + i);
        const wide = msg.length > 2 ? 'score-btn-wide' : '';
        body += `<button class="score-btn ${active} ${wide}" data-score="${i}">${msg}</button>`;
      }

      body += `<div class="popup-josm">
        <button class="popup-josm-btn" data-polygon-id="${poly.id}">Open in JOSM</button>
      </div>`;

      body += `</div>
      <div class="popup-actions">
        <button class="popup-release-btn">Release Polygon</button>
      </div>`;
    } else if (!poly.claimed_by_id) {
      // Unclaimed
      if (!_user || !_user.authenticated) {
        body += `<div class="popup-actions">
          <button class="popup-claim-btn" data-polygon-id="${poly.id}">Login &amp; Claim</button>
        </div>`;
      } else if (userHasOtherClaim) {
        body += `<div class="popup-must-release">You must release your current polygon first</div>`;
      } else {
        body += `<div class="popup-actions">
          <button class="popup-claim-btn" data-polygon-id="${poly.id}">Claim Polygon</button>
        </div>`;
      }
    }
    body += '</div>';
    return body;
  }

  function bindPopupButtons(polygonId) {
    // JOSM button
    $('.popup-josm-btn').on('click', function () {
      openInJosm(parseInt($(this).data('polygon-id')), _projectTitle);
    });

    // Score buttons
    $('.score-btn').on('click', function () {
      const score = parseInt($(this).data('score'));
      setScore(polygonId, score);
    });

    // Release button
    $('.popup-release-btn').on('click', function () {
      releasePolygon(polygonId);
    });

    // Claim button
    $('.popup-claim-btn').on('click', function () {
      const pid = parseInt($(this).data('polygon-id'));
      if (!_user || !_user.authenticated) {
        // Redirect to login with claim intent
        const callbackUrl = `/map/${_projectId}?claim=${pid}`;
        window.location.href = `/auth/login?next=${encodeURIComponent(callbackUrl)}`;
      } else {
        attemptClaim(pid);
      }
    });
  }

  function hasActiveClaim() {
    return _polygons.some(p => p.claimed_by_id === _user.id);
  }

  // ─── Claim / Release / Score ───────────────────────────────────────

  async function attemptClaim(polygonId) {
    try {
      await MPT.api.post(`/api/polygons/${polygonId}/claim`, {});
      // WebSocket will update; also reopen popup
      setTimeout(() => openPolygonPopup(polygonId), 100);
    } catch (xhr) {
      const msg = xhr.responseJSON && xhr.responseJSON.detail
        ? xhr.responseJSON.detail : 'Could not claim polygon.';
      showMapNotice(msg, 'error');
    }
  }

  async function releasePolygon(polygonId) {
    try {
      await MPT.api.post(`/api/polygons/${polygonId}/release`, {});
      _map.closePopup();
    } catch (xhr) {
      const msg = xhr.responseJSON && xhr.responseJSON.detail
        ? xhr.responseJSON.detail : 'Could not release polygon.';
      showMapNotice(msg, 'error');
    }
  }

  async function setScore(polygonId, score) {
    try {
      await MPT.api.post(`/api/polygons/${polygonId}/status`, { status: score });
      // Update score buttons immediately
      $('.score-btn').removeClass('active');
      $(`.score-btn[data-score="${score}"]`).addClass('active');
    } catch (e) {
      showMapNotice('Could not update score.', 'error');
    }
  }

  // ─── WebSocket ─────────────────────────────────────────────────────

  function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/projects/${_projectId}`;

    _ws = new WebSocket(url);

    _ws.onmessage = function (e) {
      let event;
      try { event = JSON.parse(e.data); } catch { return; }
      handleWsEvent(event);
    };

    _ws.onclose = function () {
      // Reconnect with back-off
      setTimeout(() => {
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, 30000);
        connectWebSocket();
      }, _wsReconnectDelay);
    };

    _ws.onopen = function () {
      _wsReconnectDelay = 1000;
    };
  }

  function handleWsEvent(event) {
    const { type, polygon_id } = event;
    const poly = getPolygon(polygon_id);
    if (!poly) return;

    if (type === 'claimed') {
      poly.claimed_by_id = event.user_id;
      poly.claimed_by_username = event.username;
      updatePolygonStyle(polygon_id);
    } else if (type === 'released') {
      poly.claimed_by_id = null;
      poly.claimed_by_username = null;
      updatePolygonStyle(polygon_id);
    } else if (type === 'status') {
      poly.status = event.status;
      updatePolygonStyle(polygon_id);
    }

    // Refresh stats
    loadStats();

    // If popup is open for this polygon, refresh it
    if (_openPopupPolygonId === polygon_id) {
      openPolygonPopup(polygon_id);
    }
  }

  // ─── Toast notice ──────────────────────────────────────────────────

  let _noticeTimer;
  function showMapNotice(msg, type) {
    let $notice = $('#map-notice');
    if (!$notice.length) {
      $notice = $('<div id="map-notice"></div>').css({
        position: 'absolute',
        bottom: '1.5rem',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        padding: '0.6rem 1.25rem',
        borderRadius: '4px',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.8rem',
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        maxWidth: '320px',
        textAlign: 'center',
        transition: 'opacity 0.3s',
      }).appendTo('#map');
    }

    const bg = type === 'error' ? '#ff4d6d' : '#5ae4a8';
    const color = type === 'error' ? '#fff' : '#0e0f11';
    $notice.css({ background: bg, color }).text(msg).css('opacity', 1).show();

    clearTimeout(_noticeTimer);
    _noticeTimer = setTimeout(() => $notice.fadeOut(), 3500);
  }

})(jQuery);
