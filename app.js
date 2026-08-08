/* Offload — brain-dump task PWA.
   Flat node array; hierarchy derived from parentId. Interaction model ported
   from the Claude Design prototype (list gestures are the product). */
(() => {
  'use strict';

  // Keep in lockstep with the CACHE name in sw.js — bump both every deploy.
  const APP_VERSION = 'v12';

  const STORAGE_KEY = 'offload.v1';
  const MAX_DEPTH = 3;
  const LONG_PRESS_MS = 430;
  const TAP_MAX_MS = 420;
  const MOVE_TOLERANCE = 6;
  const SWIPE_START_PX = 12;
  const SWIPE_COMMIT_PX = 80;
  const SWIPE_ANGLE_RATIO = 1.3;
  const EDGE_GUARD_PX = 24;
  const UNDO_MS = 6000;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const LEAVE_COLLAPSE_MS = () => (reducedMotion.matches ? 0 : 460);
  const LEAVE_COMMIT_MS = () => (reducedMotion.matches ? 60 : 820);

  // ── State ──
  let nodes = [];              // {id, text, parentId, order, createdAt, completedAt, completedGroup}
  let view = 'list';
  let editingId = null;
  let cancelEdit = false;
  let collapsed = new Set();   // parent ids collapsed (session only)
  let leavePhase = new Map();  // id -> 1 (animating) | 2 (collapsing)
  let undoInfo = null;         // {type:'complete', group, label} | {type:'delete', nodes, label}
  let refuseId = null;
  let drag = null;             // {id, sx, sy, target: {id, mode, invalid} | null}
  let swipe = null;            // {id, dx}
  let ptr = null;              // {id, x, y, moved, t, el, pid}
  let archSwipe = null;        // {id, dx}
  let ptrA = null;             // archive pointer state
  let lpTimer = 0, undoTimer = 0, refuseTimer = 0, persistTimer = 0;
  let persistDirty = false;
  let preemptShrink = () => {}; // assigned in the keyboard section when visualViewport exists
  const rowEls = new Map();    // id -> {wrap, row} (list)
  const archEls = new Map();   // id -> {wrap, row} (archive)

  // ── Persistence ──
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw && raw.version === 1 && Array.isArray(raw.nodes)) nodes = raw.nodes;
    } catch (e) { /* corrupt storage: start fresh rather than crash */ }
  }
  function flushPersist() {
    if (!persistDirty) return;
    persistDirty = false;
    clearTimeout(persistTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, nodes }));
    } catch (e) { /* quota/private mode: keep running in memory */ }
  }
  function persist() {
    persistDirty = true;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, 300);
  }
  window.addEventListener('pagehide', flushPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });

  // ── Derived queries ──
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  const byId = id => nodes.find(n => n.id === id);
  const isActive = n => n.completedAt === null;
  function kidsOf(pid) {
    return nodes.filter(n => isActive(n) && n.parentId === pid).sort((a, b) => a.order - b.order);
  }
  function depth(id) {
    let d = 0, n = byId(id);
    while (n) { d++; n = byId(n.parentId); }
    return d;
  }
  function heightOf(id) {
    const k = kidsOf(id);
    return k.length ? 1 + Math.max(...k.map(c => heightOf(c.id))) : 1;
  }
  function descIds(id, set) {
    set = set || new Set();
    kidsOf(id).forEach(k => { set.add(k.id); descIds(k.id, set); });
    return set;
  }
  function isDescOf(id, ancId) {
    let n = byId(id);
    while (n && n.parentId) {
      if (n.parentId === ancId) return true;
      n = byId(n.parentId);
    }
    return false;
  }
  function crumbOf(n) {
    const parts = [];
    let p = byId(n.parentId);
    while (p) { parts.unshift(p.text); p = byId(p.parentId); }
    return parts.length ? parts.join(' › ') + ' ›' : '';
  }
  function relTime(ts) {
    const d = Date.now() - ts, m = 60000, h = 3600000;
    if (d < m) return 'just now';
    if (d < h) return Math.round(d / m) + 'm ago';
    if (d < 24 * h) return Math.round(d / h) + 'h ago';
    if (d < 48 * h) return 'yesterday';
    return Math.round(d / (24 * h)) + 'd ago';
  }

  // ── Mutations ──
  function addTask(text) {
    // New tasks append at the bottom: list reads oldest → newest.
    const roots = nodes.filter(n => isActive(n) && n.parentId === null);
    const order = roots.length ? Math.max(...roots.map(r => r.order)) + 1 : 0;
    nodes = [...nodes, { id: uid(), text, parentId: null, order, createdAt: Date.now(), completedAt: null, completedGroup: null }];
    persist();
    render();
    // Keep the fresh card in view, right above the input.
    const screen = listEl.closest('.screen');
    if (screen) screen.scrollTop = screen.scrollHeight;
  }

  function complete(id) {
    const mark = new Set([id]);
    descIds(id).forEach(i => mark.add(i));
    // Auto-complete ancestors left with no active children. Rows mid-leave
    // count as gone so parallel swipes still collapse the parent.
    let p = (byId(id) || {}).parentId;
    while (p) {
      const rest = nodes.filter(n => isActive(n) && n.parentId === p && !mark.has(n.id) && !leavePhase.has(n.id));
      if (rest.length) break;
      mark.add(p);
      p = (byId(p) || {}).parentId;
    }
    mark.forEach(i => {
      leavePhase.set(i, 1);
      const els = rowEls.get(i);
      if (els) els.row.classList.add('leave');
    });
    swipe = null;
    setTimeout(() => {
      mark.forEach(i => {
        if (leavePhase.get(i) === 1) {
          leavePhase.set(i, 2);
          const els = rowEls.get(i);
          if (els) els.wrap.classList.add('gone');
        }
      });
    }, LEAVE_COLLAPSE_MS());
    setTimeout(() => commitComplete(mark), LEAVE_COMMIT_MS());
  }

  function commitComplete(mark) {
    const group = uid(), now = Date.now();
    let label = '';
    mark.forEach(i => {
      const n = byId(i);
      if (n && (!n.parentId || !mark.has(n.parentId))) label = n.text;
    });
    if (label.length > 24) label = label.slice(0, 23) + '…';
    nodes = nodes.map(n => mark.has(n.id) ? { ...n, completedAt: now, completedGroup: group } : n);
    mark.forEach(i => leavePhase.delete(i));
    persist();
    showUndo({ type: 'complete', group, label: '“' + label + '” done' });
    render();
  }

  // Animate the pill out when its timer expires instead of blinking away.
  function showUndo(info) {
    clearTimeout(undoTimer);
    const pill = $('undoPill');
    pill.classList.remove('hide');
    undoInfo = info;
    undoTimer = setTimeout(() => {
      pill.classList.add('hide');
      undoTimer = setTimeout(() => {
        pill.classList.remove('hide');
        undoInfo = null;
        render();
      }, 220);
    }, UNDO_MS);
  }

  // Permanent delete of an archived node and its (archived) descendants.
  // Recoverable only via the undo pill; once it expires the nodes are gone.
  function deleteArchived(id) {
    const mark = new Set([id]);
    nodes.forEach(n => { if (isDescOf(n.id, id)) mark.add(n.id); });
    mark.forEach(i => {
      leavePhase.set(i, 1);
      const els = archEls.get(i);
      if (els) els.row.classList.add('leave');
    });
    archSwipe = null;
    setTimeout(() => {
      mark.forEach(i => {
        if (leavePhase.get(i) === 1) {
          leavePhase.set(i, 2);
          const els = archEls.get(i);
          if (els) els.wrap.classList.add('gone');
        }
      });
    }, LEAVE_COLLAPSE_MS());
    setTimeout(() => commitDelete(mark), LEAVE_COMMIT_MS());
  }

  function commitDelete(mark) {
    const n = byId([...mark][0]);
    let label = n ? n.text : '';
    if (label.length > 24) label = label.slice(0, 23) + '…';
    const deleted = nodes.filter(x => mark.has(x.id));
    nodes = nodes.filter(x => !mark.has(x.id));
    mark.forEach(i => leavePhase.delete(i));
    persist();
    showUndo({ type: 'delete', nodes: deleted, label: '“' + label + '” deleted' });
    render();
  }

  function undo() {
    if (!undoInfo) return;
    if (undoInfo.type === 'delete') {
      nodes = [...undoInfo.nodes, ...nodes];
    } else {
      const g = undoInfo.group;
      nodes = nodes.map(n => n.completedGroup === g ? { ...n, completedAt: null, completedGroup: null } : n);
    }
    undoInfo = null;
    clearTimeout(undoTimer);
    $('undoPill').classList.remove('hide');
    persist();
    render();
  }

  function restore(id) {
    const n = byId(id);
    if (!n || leavePhase.has(id)) return;
    const revive = new Set([id]);
    let p = n.parentId;
    while (p) {
      const pn = byId(p);
      if (pn && pn.completedAt !== null) revive.add(p);
      p = pn ? pn.parentId : null;
    }
    nodes.forEach(x => {
      if (x.completedAt !== null && x.completedGroup === n.completedGroup && isDescOf(x.id, id)) revive.add(x.id);
    });
    nodes = nodes.map(x => revive.has(x.id) ? { ...x, completedAt: null, completedGroup: null } : x);
    persist();
    render();
  }

  function commitEdit() {
    const id = editingId;
    if (!id) return;
    const input = document.getElementById('editInput');
    const txt = input && !cancelEdit ? input.value.trim() : '';
    if (txt) {
      nodes = nodes.map(n => n.id === id ? { ...n, text: txt } : n);
      persist();
    }
    editingId = null;
    cancelEdit = false;
    render();
  }

  function toggleCollapse(id) {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    render();
  }

  // ── Drag & drop ──
  function startDrag() {
    if (!ptr) return;
    try { ptr.el.setPointerCapture(ptr.pid); } catch (e) {}
    drag = { id: ptr.id, sx: ptr.x, sy: ptr.y, target: null };
    const els = rowEls.get(ptr.id);
    if (els) {
      els.wrap.classList.add('lifted');
      els.row.classList.add('drag-src', 'no-tr');
    }
  }

  function clearTargetVisuals() {
    rowEls.forEach(({ wrap, row }) => {
      wrap.classList.remove('gap-before', 'gap-after');
      row.classList.remove('nest-ok', 'nest-bad');
    });
  }

  function updateDrag(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    const els = rowEls.get(drag.id);
    if (els) els.row.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.045)';

    const excluded = descIds(drag.id);
    excluded.add(drag.id);
    let target = null;
    for (const [id, { row }] of rowEls) {
      if (excluded.has(id) || leavePhase.has(id)) continue;
      const r = row.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        const rel = (e.clientY - r.top) / r.height;
        if (rel > 0.28 && rel < 0.72) {
          target = { id, mode: 'nest', invalid: depth(id) + heightOf(drag.id) > MAX_DEPTH };
        } else {
          target = { id, mode: rel <= 0.28 ? 'before' : 'after' };
        }
        break;
      }
    }
    drag.target = target;
    clearTargetVisuals();
    if (target) {
      const t = rowEls.get(target.id);
      if (t) {
        if (target.mode === 'nest') t.row.classList.add(target.invalid ? 'nest-bad' : 'nest-ok');
        else t.wrap.classList.add(target.mode === 'before' ? 'gap-before' : 'gap-after');
      }
    }
  }

  function refusal(targetId) {
    clearTimeout(refuseTimer);
    drag = null;
    refuseId = targetId;
    render();
    refuseTimer = setTimeout(() => { refuseId = null; render(); }, 1000);
  }

  function drop() {
    const d = drag;
    if (!d) return;
    const t = d.target;
    if (t && t.mode === 'nest') {
      if (t.invalid) { refusal(t.id); return; }
      const sibs = kidsOf(t.id).filter(k => k.id !== d.id);
      const order = sibs.length ? Math.max(...sibs.map(s => s.order)) + 1 : 0;
      nodes = nodes.map(n => n.id === d.id ? { ...n, parentId: t.id, order } : n);
      collapsed.delete(t.id);
      drag = null;
      persist();
      render();
      return;
    }
    if (t && (t.mode === 'before' || t.mode === 'after')) {
      const anchor = byId(t.id);
      const pid = anchor ? anchor.parentId : null;
      const pDepth = pid ? depth(pid) : 0;
      if (pDepth + heightOf(d.id) > MAX_DEPTH) { refusal(t.id); return; }
      const sibs = kidsOf(pid).filter(k => k.id !== d.id);
      let idx = sibs.findIndex(s => s.id === t.id);
      if (idx < 0) { drag = null; render(); return; }
      if (t.mode === 'after') idx++;
      const seq = sibs.map(s => s.id);
      seq.splice(idx, 0, d.id);
      const orderMap = new Map(seq.map((sid, i) => [sid, i]));
      nodes = nodes.map(n => {
        if (n.id === d.id) return { ...n, parentId: pid, order: orderMap.get(n.id) };
        if (orderMap.has(n.id)) return { ...n, order: orderMap.get(n.id) };
        return n;
      });
      drag = null;
      persist();
      render();
      return;
    }
    drag = null;
    render();
  }

  // ── Swipe glyph: ✓ (complete) or ✕ (delete) revealed in the gutter ──
  // Opacity tracks drag distance, then pops to full once past the commit
  // threshold so release feels deliberate. Lives behind the row inside .clip.
  function glyphSvg(kind) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', kind === 'del' ? 'M3.5 3.5l9 9M12.5 3.5l-9 9' : 'M2.5 8.5l3.5 3.5L13.5 4');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function updateSwipeGlyph(rowEl, dx, kind) {
    const clip = rowEl.parentElement;
    let g = clip.querySelector('.swipe-glyph');
    if (!g) {
      g = el('div', 'swipe-glyph' + (kind === 'del' ? ' del' : ''));
      g.appendChild(glyphSvg(kind));
      clip.insertBefore(g, clip.firstChild);
    }
    if (dx > 0) {
      // Hug the card's own left edge (which carries the depth indent).
      g.style.left = ((parseFloat(rowEl.style.marginLeft) || 8) + 14) + 'px';
      g.style.right = 'auto';
    } else {
      g.style.left = 'auto';
      g.style.right = '22px';
    }
    const committed = Math.abs(dx) > SWIPE_COMMIT_PX;
    g.style.opacity = committed ? '1' : String((Math.abs(dx) / SWIPE_COMMIT_PX) * .4);
    g.classList.toggle('commit', committed);
  }

  function fadeSwipeGlyph(rowEl) {
    const clip = rowEl.parentElement;
    const g = clip && clip.querySelector('.swipe-glyph');
    if (!g) return;
    g.style.opacity = '0';
    g.classList.remove('commit');
    setTimeout(() => g.remove(), 220);
  }

  // ── Pointer gestures (no HTML5 DnD — pointer events only) ──
  function onPointerDown(e) {
    if (e.target.closest('[data-ng]')) return;
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (editingId === id || leavePhase.has(id)) return;
    ptr = { id, x: e.clientX, y: e.clientY, moved: false, t: Date.now(), el: row, pid: e.pointerId };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (ptr && ptr.id === id && !ptr.moved && !swipe) startDrag();
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e) {
    if (!ptr) return;
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
    if (Math.abs(dx) > MOVE_TOLERANCE || Math.abs(dy) > MOVE_TOLERANCE) {
      ptr.moved = true;
      if (!drag) clearTimeout(lpTimer);
    }
    if (drag) { updateDrag(e); return; }
    if (!swipe) {
      // Horizontal-dominant start, away from screen edges (iOS back-swipe).
      const nearEdge = ptr.x < EDGE_GUARD_PX || ptr.x > window.innerWidth - EDGE_GUARD_PX;
      if (!nearEdge && Math.abs(dx) > SWIPE_START_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_ANGLE_RATIO) {
        try { ptr.el.setPointerCapture(ptr.pid); } catch (err) {}
        swipe = { id: ptr.id, dx };
        ptr.el.classList.add('no-tr');
      }
    }
    if (swipe) {
      swipe.dx = dx;
      ptr.el.style.transform = 'translateX(' + dx + 'px)';
      updateSwipeGlyph(ptr.el, dx, 'done');
    }
  }

  function onPointerUp(e) {
    clearTimeout(lpTimer);
    if (drag) { drop(); ptr = null; return; }
    if (swipe && ptr && swipe.id === ptr.id) {
      const el = ptr.el;
      if (Math.abs(swipe.dx) > SWIPE_COMMIT_PX) {
        el.classList.remove('no-tr');
        complete(swipe.id);
      } else {
        swipe = null;
        el.classList.remove('no-tr');
        el.style.transform = '';
        fadeSwipeGlyph(el);
      }
      ptr = null;
      return;
    }
    if (ptr && !ptr.moved && Date.now() - ptr.t < TAP_MAX_MS) beginEdit(ptr.id);
    ptr = null;
  }

  function onPointerCancel() {
    clearTimeout(lpTimer);
    ptr = null;
    if (drag || swipe) { drag = null; swipe = null; render(); }
  }

  // Archive swipe: same thresholds as the list, but the only outcome is
  // permanent deletion (with the undo pill as the single recovery path).
  function onArchPointerDown(e) {
    if (e.target.closest('[data-ng]')) return;
    const row = e.target.closest('.arow');
    if (!row) return;
    const id = row.dataset.id;
    if (leavePhase.has(id)) return;
    ptrA = { id, x: e.clientX, y: e.clientY, el: row, pid: e.pointerId };
  }
  function onArchPointerMove(e) {
    if (!ptrA) return;
    const dx = e.clientX - ptrA.x, dy = e.clientY - ptrA.y;
    if (!archSwipe) {
      const nearEdge = ptrA.x < EDGE_GUARD_PX || ptrA.x > window.innerWidth - EDGE_GUARD_PX;
      if (!nearEdge && Math.abs(dx) > SWIPE_START_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_ANGLE_RATIO) {
        try { ptrA.el.setPointerCapture(ptrA.pid); } catch (err) {}
        archSwipe = { id: ptrA.id, dx };
        ptrA.el.classList.add('no-tr');
      }
    }
    if (archSwipe) {
      archSwipe.dx = dx;
      ptrA.el.style.transform = 'translateX(' + dx + 'px)';
      updateSwipeGlyph(ptrA.el, dx, 'del');
    }
  }
  function onArchPointerUp() {
    if (archSwipe && ptrA && archSwipe.id === ptrA.id) {
      const el = ptrA.el;
      if (Math.abs(archSwipe.dx) > SWIPE_COMMIT_PX) {
        el.classList.remove('no-tr');
        deleteArchived(archSwipe.id);
      } else {
        archSwipe = null;
        el.classList.remove('no-tr');
        el.style.transform = '';
        fadeSwipeGlyph(el);
      }
    }
    ptrA = null;
  }
  function onArchPointerCancel() {
    if (archSwipe && ptrA) {
      ptrA.el.classList.remove('no-tr');
      ptrA.el.style.transform = '';
      fadeSwipeGlyph(ptrA.el);
    }
    archSwipe = null;
    ptrA = null;
  }

  function beginEdit(id) {
    if (!byId(id)) return;
    editingId = id;
    cancelEdit = false;
    preemptShrink();
    render();
    const input = document.getElementById('editInput');
    if (input) {
      input.focus({ preventScroll: true });
      const n = input.value.length;
      try { input.setSelectionRange(n, n); } catch (e) {}
    }
  }

  // ── Rendering ──
  const $ = id => document.getElementById(id);
  const listEl = $('list'), archEl = $('arch');

  function chevronSvg() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('viewBox', '0 0 12 12');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M4 2l5 4-5 4');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildRow(n, depthLevel, ordinal) {
    const kids = kidsOf(n.id);
    const isParent = kids.length > 0;
    const isCollapsed = collapsed.has(n.id);

    const wrap = el('div', 'rw');
    const clip = el('div', 'clip');
    const row = el('div', 'row' + (isParent ? ' parent' : '') + (editingId === n.id ? ' editing' : ''));
    row.dataset.id = n.id;
    // Indent the card itself so hierarchy reads at the card edge.
    row.style.marginLeft = (8 + (depthLevel - 1) * 24) + 'px';

    if (isParent) {
      const chev = el('button', 'chev' + (isCollapsed ? ' closed' : ''));
      chev.type = 'button';
      chev.dataset.ng = '1';
      chev.dataset.act = 'toggle';
      chev.dataset.id = n.id;
      chev.setAttribute('aria-label', isCollapsed ? 'Expand' : 'Collapse');
      chev.appendChild(chevronSvg());
      row.appendChild(chev);
    } else if (depthLevel > 1) {
      row.appendChild(el('div', 'ord', ordinal + '.'));
    } else {
      const dc = el('div', 'dotcol');
      dc.appendChild(el('div', 'dot'));
      row.appendChild(dc);
    }

    const txtwrap = el('div', 'txtwrap');
    if (editingId === n.id) {
      const input = el('input', 'edit');
      input.id = 'editInput';
      input.type = 'text';
      input.value = n.text;
      input.autocapitalize = 'sentences';
      input.enterKeyHint = 'done';
      input.addEventListener('blur', commitEdit);
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') ev.target.blur();
        else if (ev.key === 'Escape') { cancelEdit = true; ev.target.blur(); }
      });
      txtwrap.appendChild(input);
    } else {
      txtwrap.appendChild(el('div', 'txt', n.text));
    }
    row.appendChild(txtwrap);

    if (isParent && isCollapsed) row.appendChild(el('div', 'count', String(kids.length)));
    if (refuseId === n.id) {
      row.appendChild(el('div', 'refuse-cap', 'three levels max'));
      row.classList.add('shake');
    }

    const ph = leavePhase.get(n.id);
    if (ph) {
      row.classList.add('leave');
      if (ph === 2) wrap.classList.add('gone');
    }

    clip.appendChild(row);
    clip.appendChild(el('div', 'hairline'));
    wrap.appendChild(clip);
    rowEls.set(n.id, { wrap, row });
    return { wrap, isParent, isCollapsed };
  }

  function renderList() {
    rowEls.clear();
    listEl.textContent = '';
    const frag = document.createDocumentFragment();
    let count = 0;
    const walk = (pid, depthLevel) => {
      kidsOf(pid).forEach((n, i) => {
        count++;
        const { wrap, isParent, isCollapsed } = buildRow(n, depthLevel, i + 1);
        frag.appendChild(wrap);
        if (isParent && !isCollapsed) walk(n.id, depthLevel + 1);
      });
    };
    walk(null, 1);
    listEl.appendChild(frag);
    $('listEmpty').hidden = count > 0;
  }

  function renderArch() {
    archEls.clear();
    archEl.textContent = '';
    const frag = document.createDocumentFragment();
    const done = nodes.filter(n => n.completedAt !== null).sort((a, b) => b.completedAt - a.completedAt);
    done.forEach(n => {
      const wrap = el('div', 'rw');
      const clip = el('div', 'clip');
      const arow = el('div', 'arow');
      arow.dataset.id = n.id;
      const body = el('div', 'body');
      const crumb = crumbOf(n);
      if (crumb) body.appendChild(el('div', 'crumb', crumb));
      body.appendChild(el('div', 'atxt', n.text));
      arow.appendChild(body);
      arow.appendChild(el('div', 'when', relTime(n.completedAt)));
      const btn = el('button', 'putback', 'Put back');
      btn.type = 'button';
      btn.dataset.ng = '1';
      btn.dataset.act = 'restore';
      btn.dataset.id = n.id;
      arow.appendChild(btn);
      const ph = leavePhase.get(n.id);
      if (ph) {
        arow.classList.add('leave');
        if (ph === 2) wrap.classList.add('gone');
      }
      clip.appendChild(arow);
      clip.appendChild(el('div', 'hairline'));
      wrap.appendChild(clip);
      archEls.set(n.id, { wrap, row: arow });
      frag.appendChild(wrap);
    });
    frag.appendChild(el('div', 'ver', APP_VERSION));
    archEl.appendChild(frag);
    $('archEmpty').hidden = done.length > 0;
  }

  function render() {
    renderList();
    renderArch();
    $('tabList').classList.toggle('active', view === 'list');
    $('tabArch').classList.toggle('active', view === 'archive');
    $('tabs').classList.toggle('archive', view === 'archive');
    $('track').classList.toggle('archive', view === 'archive');
    const pill = $('undoPill');
    pill.hidden = !undoInfo;
    if (undoInfo) $('undoLabel').textContent = undoInfo.label;
  }

  // ── Wiring ──
  listEl.addEventListener('pointerdown', onPointerDown);
  listEl.addEventListener('pointermove', onPointerMove);
  listEl.addEventListener('pointerup', onPointerUp);
  listEl.addEventListener('pointercancel', onPointerCancel);
  listEl.addEventListener('contextmenu', e => e.preventDefault());

  archEl.addEventListener('pointerdown', onArchPointerDown);
  archEl.addEventListener('pointermove', onArchPointerMove);
  archEl.addEventListener('pointerup', onArchPointerUp);
  archEl.addEventListener('pointercancel', onArchPointerCancel);
  archEl.addEventListener('contextmenu', e => e.preventDefault());

  // iOS Safari only applies :active during touch when a touchstart listener
  // exists in the chain — required for the press states to show at all.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // touch-action stays pan-y for normal scrolling; once a swipe or drag owns
  // the gesture, block the browser's scroll/pull-to-refresh outright.
  document.addEventListener('touchmove', e => {
    if (drag || swipe || archSwipe) e.preventDefault();
  }, { passive: false });

  document.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'toggle') toggleCollapse(act.dataset.id);
    else if (act.dataset.act === 'restore') restore(act.dataset.id);
  });

  $('tabList').addEventListener('click', () => { view = 'list'; render(); });
  $('tabArch').addEventListener('click', () => { view = 'archive'; render(); });
  $('undoBtn').addEventListener('click', undo);

  const newTask = $('newTask');
  // Native focus fires before any JS can resize, so iOS would pan. Block it,
  // shrink first (with layout flush inside preemptShrink), then focus
  // synchronously in the same gesture so the keyboard still opens.
  newTask.addEventListener('touchstart', e => {
    if (document.activeElement === newTask) return;
    e.preventDefault();
    preemptShrink();
    newTask.focus({ preventScroll: true });
  }, { passive: false });
  newTask.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const text = newTask.value.trim();
    if (!text) return;
    newTask.value = '';
    addTask(text);
  });

  // ── Keyboard: preempt the iOS pan instead of counteracting it ──
  // iOS pans the visual viewport when the focused input would be covered by
  // the keyboard, and it snapshots the input's geometry AT FOCUS TIME — a
  // focusin handler is already too late (proven on-device in v6). So the
  // shrink must land before focus: callers run preemptShrink() and force a
  // layout flush, then focus programmatically in the same gesture. The app
  // is then already short enough that iOS has nothing to reveal: no pan,
  // and a height change never moves top-anchored content. Keyboard height
  // starts as a deliberate overestimate (a brief gap is invisible; an
  // undershoot pans), then is measured and cached.
  const vv = window.visualViewport;
  if (vv) {
    const appEl = document.getElementById('app');
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    let kbCache = 0;
    try { kbCache = +(localStorage.getItem('offload.kb') || 0); } catch (e) {}
    let preempted = false;
    let kbRaf = 0;

    const applyPin = () => {
      const shortfall = window.innerHeight - vv.height;
      if (shortfall > 40) {
        preempted = false;
        appEl.style.height = vv.height + 'px';
        appEl.style.transform = vv.offsetTop > 0 ? 'translateY(' + vv.offsetTop + 'px)' : '';
        appEl.classList.add('kb-open');
        if (shortfall > 100 && shortfall !== kbCache) {
          kbCache = shortfall;
          try { localStorage.setItem('offload.kb', String(shortfall)); } catch (e) {}
        }
      } else if (!preempted) {
        appEl.style.height = '';
        appEl.style.transform = '';
        appEl.classList.remove('kb-open');
      }
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };
    const onViewport = () => {
      cancelAnimationFrame(kbRaf);
      kbRaf = requestAnimationFrame(applyPin);
    };
    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);

    preemptShrink = () => {
      if (!coarse || preempted) return;
      if (window.innerHeight - vv.height > 40) return; // keyboard already up
      preempted = true;
      appEl.style.height = (window.innerHeight - (kbCache || 360)) + 'px';
      appEl.classList.add('kb-open');
      void appEl.offsetHeight; // flush layout before the caller focuses
      // Hardware keyboard / no resize: revert rather than stay shrunken.
      setTimeout(() => { if (preempted) { preempted = false; applyPin(); } }, 700);
    };

    window.addEventListener('focusin', e => {
      if (e.target.matches('input')) preemptShrink(); // fallback for untapped focus routes
    });
    window.addEventListener('focusout', () => {
      preempted = false;
      setTimeout(onViewport, 50);
      setTimeout(onViewport, 300);
    });
  }

  // ── Boot ──
  load();
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    });
  }
})();
