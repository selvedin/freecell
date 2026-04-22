const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RED_SUITS = new Set(['♥', '♦']);

// ── IndexedDB ──────────────────────────────────────────────────────────────
const DB_NAME    = 'freecell';
const DB_VERSION = 2;
const SESSION_STORE = 'session';
const RESULTS_STORE = 'results';
const SESSION_KEY   = 'current';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE);
      }
      if (!db.objectStoreNames.contains(RESULTS_STORE)) {
        const store = db.createObjectStore(RESULTS_STORE, { autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbPut(db, storeName, key, value) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = key !== null
      ? tx.objectStore(storeName).put(value, key)
      : tx.objectStore(storeName).add(value);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function dbDelete(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtTime(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ── Vue app ────────────────────────────────────────────────────────────────
new Vue({
  el: '#app',

  data() {
    return {
      // Game state
      deck:        [],
      tableau:     [[], [], [], [], [], [], [], []],
      freeCells:   [null, null, null, null],
      foundations: [
        { suit: '♠', cards: [] },
        { suit: '♥', cards: [] },
        { suit: '♦', cards: [] },
        { suit: '♣', cards: [] },
      ],
      dragPayload: null,
      dropTarget:  null,
      moves:       0,
      won:         false,
      history:     [],
      timer:       0,
      timerInterval: null,
      gameStarted: false,  // true once player has made at least 1 move

      // Persistence
      db: null,

      // Hint
      hint:           null,   // { fromZone, fromIndex, fromCardIdx, toZone, toIndex }
      hintTimeout:    null,
      hintsUsed:      0,

      // Click-to-move selection
      selected:       null,   // { cards, fromZone, fromIndex, fromCardIdx }
      clickTimeout:   null,   // debounce single vs double click
      lastDragEndTime: 0,     // suppress click fired right after drag
      lastTapInfo:    null,   // { time, zone, index, cardIdx } for mobile double-tap detection

      // Stats
      showStats:    false,
      allResults:   [],
      statsFilter:  'all',   // 'all' | 'won' | 'lost'
      statsPage:    0,
      PAGE_SIZE:    10,
    };
  },

  computed: {
    formattedTime() {
      return fmtTime(this.timer);
    },

    // ── Derived stats ──────────────────────────────────────────────────────
    totalPlayed() { return this.allResults.length; },

    totalWon() { return this.allResults.filter(r => r.won).length; },

    winRate() {
      if (!this.totalPlayed) return '—';
      return Math.round(this.totalWon / this.totalPlayed * 100) + '%';
    },

    bestTime() {
      const wins = this.allResults.filter(r => r.won);
      if (!wins.length) return '—';
      return fmtTime(Math.min(...wins.map(r => r.time)));
    },

    avgTime() {
      const wins = this.allResults.filter(r => r.won);
      if (!wins.length) return '—';
      return fmtTime(Math.round(wins.reduce((a, r) => a + r.time, 0) / wins.length));
    },

    fewestMoves() {
      const wins = this.allResults.filter(r => r.won);
      if (!wins.length) return '—';
      return Math.min(...wins.map(r => r.moves));
    },

    avgMoves() {
      const wins = this.allResults.filter(r => r.won);
      if (!wins.length) return '—';
      return Math.round(wins.reduce((a, r) => a + r.moves, 0) / wins.length);
    },

    currentStreak() {
      let streak = 0;
      for (let i = this.allResults.length - 1; i >= 0; i--) {
        if (this.allResults[i].won) streak++;
        else break;
      }
      return streak;
    },

    bestStreak() {
      let best = 0, cur = 0;
      for (const r of this.allResults) {
        cur = r.won ? cur + 1 : 0;
        if (cur > best) best = cur;
      }
      return best;
    },

    filteredResults() {
      const list = [...this.allResults].reverse();
      if (this.statsFilter === 'won')  return list.filter(r => r.won);
      if (this.statsFilter === 'lost') return list.filter(r => !r.won);
      return list;
    },

    pagedResults() {
      const start = this.statsPage * this.PAGE_SIZE;
      return this.filteredResults.slice(start, start + this.PAGE_SIZE);
    },

    totalPages() {
      return Math.ceil(this.filteredResults.length / this.PAGE_SIZE);
    },
  },

  async mounted() {
    window.addEventListener('keydown', this.onKeyDown);
    try {
      this.db = await openDB();
      const saved = await dbGet(this.db, SESSION_STORE, SESSION_KEY);
      if (saved) {
        this.tableau     = saved.tableau;
        this.freeCells   = saved.freeCells;
        this.foundations = saved.foundations;
        this.moves       = saved.moves;
        this.timer       = saved.timer;
        this.won         = saved.won;
        this.history     = saved.history || [];
        this.gameStarted = saved.gameStarted || false;
        this.hintsUsed   = saved.hintsUsed   || 0;
        if (!this.won) this.startTimer();
      } else {
        this.newGame();
      }
      await this.loadResults();
    } catch (err) {
      console.warn('IndexedDB unavailable, starting fresh.', err);
      this.newGame();
    }
  },

  beforeDestroy() {
    window.removeEventListener('keydown', this.onKeyDown);
    clearInterval(this.timerInterval);
  },

  methods: {

    // ── Persistence — session ─────────────────────────────────────────────
    async persistState() {
      if (!this.db) return;
      try {
        await dbPut(this.db, SESSION_STORE, SESSION_KEY, {
          tableau:     JSON.parse(JSON.stringify(this.tableau)),
          freeCells:   JSON.parse(JSON.stringify(this.freeCells)),
          foundations: JSON.parse(JSON.stringify(this.foundations)),
          moves:       this.moves,
          timer:       this.timer,
          won:         this.won,
          history:     JSON.parse(JSON.stringify(this.history)),
          gameStarted: this.gameStarted,
          hintsUsed:   this.hintsUsed,
        });
      } catch (err) {
        console.warn('Could not persist state:', err);
      }
    },

    async clearSessionState() {
      if (!this.db) return;
      try { await dbDelete(this.db, SESSION_STORE, SESSION_KEY); } catch (_) {}
    },

    // ── Persistence — results ─────────────────────────────────────────────
    async saveResult(won) {
      if (!this.db) return;
      try {
        await dbPut(this.db, RESULTS_STORE, null, {
          date:      new Date().toISOString(),
          won,
          moves:     this.moves,
          time:      this.timer,
          hintsUsed: this.hintsUsed,
        });
        await this.loadResults();
      } catch (err) {
        console.warn('Could not save result:', err);
      }
    },

    async loadResults() {
      if (!this.db) return;
      try {
        this.allResults = await dbGetAll(this.db, RESULTS_STORE);
      } catch (err) {
        console.warn('Could not load results:', err);
      }
    },

    // ── Deck ──────────────────────────────────────────────────────────────
    buildDeck() {
      const deck = [];
      for (const suit of SUITS) {
        for (let i = 0; i < RANKS.length; i++) {
          const rank = RANKS[i];
          deck.push({ id: rank + suit, rank, rankValue: i + 1, suit, color: RED_SUITS.has(suit) ? 'red' : 'black' });
        }
      }
      return deck;
    },

    shuffle(deck) {
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      return deck;
    },

    dealCards() {
      const deck = this.shuffle(this.buildDeck());
      const tableau = [[], [], [], [], [], [], [], []];
      for (let i = 0; i < deck.length; i++) tableau[i % 8].push(deck[i]);
      this.tableau = tableau;
    },

    async newGame() {
      // Confirm before starting new game if current game has progress
      if (this.gameStarted && this.moves > 0 && !this.won) {
        const result = await Swal.fire({
          title: 'Start New Game?',
          text: 'Your current progress will be lost. Are you sure?',
          icon: 'warning',
          showCancelButton: true,
          confirmButtonColor: '#10b981',
          cancelButtonColor: '#6b7280',
          confirmButtonText: 'Yes, start new game',
          cancelButtonText: 'Keep playing'
        });
        if (!result.isConfirmed) {
          return;
        }
      }
      // Record abandoned game if player had made moves
      if (this.gameStarted && !this.won && this.moves > 0) {
        await this.saveResult(false);
      }
      clearInterval(this.timerInterval);
      this.timer       = 0;
      this.moves       = 0;
      this.won         = false;
      this.history     = [];
      this.clearHint();
      this.clearSelected();
      this.dragPayload = null;
      this.dropTarget  = null;
      this.gameStarted = false;
      this.hintsUsed   = 0;
      this.freeCells   = [null, null, null, null];
      this.foundations = [
        { suit: '♠', cards: [] },
        { suit: '♥', cards: [] },
        { suit: '♦', cards: [] },
        { suit: '♣', cards: [] },
      ];
      this.dealCards();
      this.startTimer();
      await this.clearSessionState();
      await this.$nextTick();
      this.persistState();
    },

    startTimer() {
      this.timerInterval = setInterval(() => {
        if (!this.won) {
          this.timer++;
          if (this.timer % 10 === 0) this.persistState();
        }
      }, 1000);
    },

    // ── Validation ────────────────────────────────────────────────────────
    isValidSequence(cards) {
      for (let i = 1; i < cards.length; i++) {
        if (cards[i-1].color === cards[i].color) return false;
        if (cards[i-1].rankValue !== cards[i].rankValue + 1) return false;
      }
      return true;
    },

    calcMaxMovable(excludeColIndex = -1) {
      const freeCellsEmpty = this.freeCells.filter(c => c === null).length;
      const emptyColumns   = this.tableau.filter((col, i) => i !== excludeColIndex && col.length === 0).length;
      return (freeCellsEmpty + 1) * Math.pow(2, emptyColumns);
    },

    canDragFromTableau(colIdx, cardIdx) {
      const cards = this.tableau[colIdx].slice(cardIdx);
      return cards.length > 0 && this.isValidSequence(cards) && cards.length <= this.calcMaxMovable();
    },

    canDropOnFreeCell(cellIndex) {
      return this.freeCells[cellIndex] === null && !!this.dragPayload && this.dragPayload.cards.length === 1;
    },

    canDropOnFoundation(cardOrCards, foundIdx) {
      const card = Array.isArray(cardOrCards) ? cardOrCards[0] : cardOrCards;
      if (!this.dragPayload || this.dragPayload.cards.length !== 1) return false;
      const f = this.foundations[foundIdx];
      if (f.suit !== card.suit) return false;
      if (f.cards.length === 0) return card.rankValue === 1;
      return card.rankValue === f.cards[f.cards.length - 1].rankValue + 1;
    },

    canDropOnTableau(cards, colIdx) {
      const col = this.tableau[colIdx];
      if (col.length === 0) return cards.length <= this.calcMaxMovable(colIdx);
      const top = col[col.length - 1];
      return cards[0].color !== top.color
          && cards[0].rankValue === top.rankValue - 1
          && cards.length <= this.calcMaxMovable(colIdx);
    },

    // ── Drag & Drop ───────────────────────────────────────────────────────
    onDragStart(e, zone, index, cards) {
      this.clearHint();
      this.clearSelected();
      this.dragPayload = { cards, fromZone: zone, fromIndex: index };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', cards.map(c => c.id).join(','));

      // Build a custom drag image that shows the full stacked sequence
      if (cards.length > 1) {
        const cs      = getComputedStyle(document.documentElement);
        const cardW   = parseFloat(cs.getPropertyValue('--card-w'))   || 56;
        const cardH   = parseFloat(cs.getPropertyValue('--card-h'))   || 80;
        const stackMt = parseFloat(cs.getPropertyValue('--stack-mt')) || -52; // negative
        const strip   = cardH + stackMt; // visible strip height (positive)
        const rankFs  = parseFloat(cs.getPropertyValue('--rank-fs'))  || 18;
        const pad     = parseFloat(cs.getPropertyValue('--card-pad')) || 4;
        const totalH  = cardH + (cards.length - 1) * strip;

        const ghost = document.createElement('div');
        ghost.style.cssText =
          `position:fixed;top:-9999px;left:-9999px;pointer-events:none;` +
          `width:${cardW}px;height:${totalH}px;`;

        cards.forEach((card, i) => {
          const el   = document.createElement('div');
          const color = card.color === 'red' ? '#dc2626' : '#111827';
          el.style.cssText =
            `position:absolute;top:${i * strip}px;left:0;` +
            `width:${cardW}px;height:${cardH}px;` +
            `background:#fff;border-radius:5px;border:1.5px solid #aaa;` +
            `box-shadow:0 3px 6px rgba(0,0,0,0.4);` +
            `display:flex;flex-direction:column;align-items:stretch;` +
            `font-family:Georgia,serif;overflow:hidden;color:${color};`;
          el.innerHTML =
            `<div style="display:flex;justify-content:space-between;` +
              `padding:${pad}px ${pad}px 0;flex-shrink:0;line-height:1;">` +
              `<span style="font-size:${rankFs}px;font-weight:bold">${card.rank}</span>` +
              `<span style="font-size:${rankFs}px;font-weight:bold">${card.suit}</span>` +
            `</div>` +
            `<div style="flex:1;display:flex;align-items:center;justify-content:center;">` +
              `<span style="font-size:${(cardH * 0.58).toFixed(1)}px;line-height:1">${card.suit}</span>` +
            `</div>`;
          ghost.appendChild(el);
        });

        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, cardW / 2, strip / 2);
        // Must stay in DOM until drag starts, then remove
        setTimeout(() => ghost.remove(), 0);
      }
    },

    onDragOver(e, zone, index) {
      if (!this.dragPayload) return;
      const { cards } = this.dragPayload;
      const valid =
        zone === 'freecell'   ? this.canDropOnFreeCell(index) :
        zone === 'foundation' ? this.canDropOnFoundation(cards[0], index) :
                                this.canDropOnTableau(cards, index);
      if (valid) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.dropTarget = { zone, index };
      } else {
        this.dropTarget = null;
      }
    },

    onDragLeave(e) {
      if (!e.currentTarget.contains(e.relatedTarget)) this.dropTarget = null;
    },

    async onDrop(e, zone, index) {
      e.preventDefault();
      if (!this.dragPayload) return;
      const { cards } = this.dragPayload;
      const valid =
        zone === 'freecell'   ? this.canDropOnFreeCell(index) :
        zone === 'foundation' ? this.canDropOnFoundation(cards[0], index) :
                                this.canDropOnTableau(cards, index);

      if (valid) {
        this.clearHint();
        this.saveHistory();
        this.executeMove(zone, index);
        this.moves++;
        this.gameStarted = true;
        this.autoMoveToFoundation();
        this.checkWin();
        this.persistState();
        if (this.won) await this.saveResult(true);
      }
      this.dragPayload = null;
      this.dropTarget  = null;
    },

    onDragEnd() {
      this.dragPayload    = null;
      this.dropTarget     = null;
      this.lastDragEndTime = Date.now();
    },

    // ── Move execution ─────────────────────────────────────────────────────
    executeMove(targetZone, targetIndex) {
      const { cards, fromZone, fromIndex } = this.dragPayload;
      if (fromZone === 'freecell') {
        Vue.set(this.freeCells, fromIndex, null);
      } else if (fromZone === 'tableau') {
        this.tableau[fromIndex] = this.tableau[fromIndex].slice(0, this.tableau[fromIndex].length - cards.length);
      }
      if (targetZone === 'freecell') {
        Vue.set(this.freeCells, targetIndex, cards[0]);
      } else if (targetZone === 'foundation') {
        this.foundations[targetIndex].cards.push(cards[0]);
      } else if (targetZone === 'tableau') {
        this.tableau[targetIndex] = [...this.tableau[targetIndex], ...cards];
      }
    },

    // ── Auto-move to foundation ───────────────────────────────────────────
    autoMoveToFoundation() {
      let moved = true;
      while (moved) {
        moved = false;
        for (let c = 0; c < 8; c++) {
          const col = this.tableau[c];
          if (!col.length) continue;
          const card = col[col.length - 1];
          const fi = this.foundations.findIndex(f => f.suit === card.suit);
          if (fi >= 0 && this.isSafeForAuto(card, this.foundations[fi])) {
            this.dragPayload = { cards: [card], fromZone: 'tableau', fromIndex: c };
            this.executeMove('foundation', fi);
            this.dragPayload = null;
            moved = true;
          }
        }
        for (let c = 0; c < 4; c++) {
          const card = this.freeCells[c];
          if (!card) continue;
          const fi = this.foundations.findIndex(f => f.suit === card.suit);
          if (fi >= 0 && this.isSafeForAuto(card, this.foundations[fi])) {
            this.dragPayload = { cards: [card], fromZone: 'freecell', fromIndex: c };
            this.executeMove('foundation', fi);
            this.dragPayload = null;
            moved = true;
          }
        }
      }
    },

    isSafeForAuto(card, foundation) {
      if (foundation.cards.length === 0 && card.rankValue !== 1) return false;
      if (foundation.cards.length > 0) {
        const top = foundation.cards[foundation.cards.length - 1];
        if (card.rankValue !== top.rankValue + 1) return false;
      }
      if (card.rankValue <= 2) return true;
      const opposingColor = card.color === 'red' ? 'black' : 'red';
      return this.foundations
        .filter(f => (RED_SUITS.has(f.suit) ? 'red' : 'black') === opposingColor)
        .every(f => f.cards.length >= card.rankValue - 1);
    },

    checkWin() {
      this.won = this.foundations.every(f => f.cards.length === 13);
      if (this.won) clearInterval(this.timerInterval);
    },

    // ── Undo ──────────────────────────────────────────────────────────────
    saveHistory() {
      this.history.push(JSON.parse(JSON.stringify({
        tableau: this.tableau, freeCells: this.freeCells,
        foundations: this.foundations, moves: this.moves,
      })));
      if (this.history.length > 50) this.history.shift();
    },

    undoMove() {
      if (!this.history.length) return;
      this.clearSelected();
      this.clearHint();
      const state      = this.history.pop();
      this.tableau     = state.tableau;
      this.freeCells   = state.freeCells;
      this.foundations = state.foundations;
      this.moves       = state.moves;
      this.won         = false;
      this.persistState();
    },

    // ── Click-to-move ─────────────────────────────────────────────────────

    /**
     * Single-click on a card. Uses a short debounce so double-click can cancel it.
     */
    onCardClick(e, zone, index, cardIdx, cards) {
      // Suppress the click that browsers fire right after dragend
      if (Date.now() - this.lastDragEndTime < 300) return;
      clearTimeout(this.clickTimeout);
      this.clickTimeout = setTimeout(() => {
        this.clickTimeout = null;
        this._doSingleClick(zone, index, cardIdx, cards);
      }, 200);
    },

    /**
     * Double-click on a card — move it to the best available destination.
     */
    onCardDblClick(e, zone, index, cardIdx, cards) {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = null;
      this._doDblClick(zone, index, cardIdx, cards);
    },

    /**
     * Touch-end handler for mobile double-tap detection.
     * dblclick is not reliably fired on touch devices, so we track taps manually.
     * First tap: record time & target, let the synthesized click fire normally.
     * Second tap within 300 ms on the same card: preventDefault (blocks click), call _doDblClick.
     */
    onCardTouch(e, zone, index, cardIdx, cards) {
      const now  = Date.now();
      const last = this.lastTapInfo;
      if (
        last &&
        now - last.time < 300 &&
        last.zone    === zone &&
        last.index   === index &&
        last.cardIdx === cardIdx
      ) {
        // Double-tap — suppress the upcoming synthesized click and handle as dblclick
        e.preventDefault();
        this.lastTapInfo = null;
        clearTimeout(this.clickTimeout);
        this.clickTimeout = null;
        this._doDblClick(zone, index, cardIdx, cards);
      } else {
        // First tap — record it and let the browser synthesize a click event
        this.lastTapInfo = { time: now, zone, index, cardIdx };
      }
    },

    /**
     * Click on an empty slot (free cell, empty tableau column, foundation label).
     */
    onSlotClick(e, zone, index) {
      if (!this.selected) return;
      if (Date.now() - this.lastDragEndTime < 300) return;
      const placed = this.tryPlaceSelected(zone, index);
      if (!placed) this.clearSelected();
    },

    _doSingleClick(zone, index, cardIdx, cards) {
      this.clearHint();

      if (this.selected) {
        // Clicking the already-selected card(s) → deselect
        const same = this.selected.fromZone === zone &&
                     this.selected.fromIndex === index &&
                     (zone !== 'tableau' || this.selected.fromCardIdx === cardIdx);
        if (same) { this.clearSelected(); return; }

        // Try to place selection onto clicked location
        const placed = this.tryPlaceSelected(zone, index);
        if (!placed) {
          // Can't place there — switch selection to clicked card if it's movable
          const movable = (zone === 'tableau' && this.canDragFromTableau(index, cardIdx)) ||
                          (zone === 'freecell' && !!cards.length);
          if (movable) {
            this.selected = { cards, fromZone: zone, fromIndex: index, fromCardIdx: cardIdx };
          } else {
            this.clearSelected();
          }
        }
      } else {
        // Nothing selected yet — select this card if it can be moved
        const movable = (zone === 'tableau' && this.canDragFromTableau(index, cardIdx)) ||
                        (zone === 'freecell' && !!cards.length);
        if (!movable) return;
        this.selected = { cards, fromZone: zone, fromIndex: index, fromCardIdx: cardIdx };
      }
    },

    _doDblClick(zone, index, cardIdx, cards) {
      this.clearHint();
      this.clearSelected();

      const movable = (zone === 'tableau' && this.canDragFromTableau(index, cardIdx)) ||
                      (zone === 'freecell' && !!cards.length);
      if (!movable) return;

      const dest = this.findBestDestinationFor(cards, zone, index);
      if (!dest) return;

      this.saveHistory();
      this.dragPayload = { cards, fromZone: zone, fromIndex: index };
      this.executeMove(dest.zone, dest.index);
      this.dragPayload = null;
      this.moves++;
      this.gameStarted = true;
      this.autoMoveToFoundation();
      this.checkWin();
      this.persistState();
      if (this.won) this.saveResult(true);
    },

    /**
     * Attempt to move `this.selected` cards to (zone, index).
     * Returns true if the move was made.
     */
    tryPlaceSelected(zone, index) {
      if (!this.selected) return false;
      const { cards, fromZone, fromIndex } = this.selected;

      const saved = this.dragPayload;
      this.dragPayload = { cards, fromZone, fromIndex };

      const valid =
        zone === 'freecell'   ? this.canDropOnFreeCell(index) :
        zone === 'foundation' ? this.canDropOnFoundation(cards[0], index) :
                                this.canDropOnTableau(cards, index);

      if (valid) {
        this.clearHint();
        this.saveHistory();
        this.executeMove(zone, index);
        this.dragPayload = saved;
        this.moves++;
        this.gameStarted = true;
        this.autoMoveToFoundation();
        this.checkWin();
        this.persistState();
        if (this.won) this.saveResult(true);
        this.clearSelected();
        return true;
      }

      this.dragPayload = saved;
      return false;
    },

    /**
     * Find the highest-scoring legal destination for a given set of cards.
     */
    findBestDestinationFor(cards, fromZone, fromIndex) {
      const saved = this.dragPayload;
      this.dragPayload = { cards, fromZone, fromIndex };
      const moves = [];

      // Foundation (single cards only)
      if (cards.length === 1) {
        for (let fi = 0; fi < 4; fi++) {
          if (this.canDropOnFoundation(cards[0], fi)) {
            moves.push({ score: 100, zone: 'foundation', index: fi });
          }
        }
      }

      // Tableau columns
      for (let tc = 0; tc < 8; tc++) {
        if (fromZone === 'tableau' && tc === fromIndex) continue;
        if (!this.canDropOnTableau(cards, tc)) continue;
        const col = this.tableau[tc];
        let score = col.length === 0 ? 8 : 30;
        if (fromZone === 'freecell') score += 20; // reward clearing free cells
        moves.push({ score, zone: 'tableau', index: tc });
      }

      // Free cell (single card, last resort)
      if (cards.length === 1 && fromZone !== 'freecell') {
        const fi = this.freeCells.findIndex(c => c === null);
        if (fi >= 0 && this.canDropOnFreeCell(fi)) {
          moves.push({ score: 2, zone: 'freecell', index: fi });
        }
      }

      this.dragPayload = saved;
      if (!moves.length) return null;
      moves.sort((a, b) => b.score - a.score);
      return moves[0];
    },

    isSelected(zone, index, cardIdx) {
      if (!this.selected) return false;
      if (this.selected.fromZone !== zone || this.selected.fromIndex !== index) return false;
      if (zone === 'tableau') return cardIdx >= this.selected.fromCardIdx;
      return true;
    },

    clearSelected() {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = null;
      this.selected = null;
    },

    // ── Hint ──────────────────────────────────────────────────────────────

    /**
     * Generate all legal moves and score them with a heuristic.
     * Returns the best { fromZone, fromIndex, fromCardIdx, toZone, toIndex } or null.
     */
    computeHint() {
      const moves = [];
      const saved = this.dragPayload;

      const evaluate = (cards, fromZone, fromIndex, fromCardIdx) => {
        // Temporarily set dragPayload so existing validators work unchanged
        this.dragPayload = { cards, fromZone, fromIndex };

        // ── To foundation ──
        if (cards.length === 1) {
          for (let fi = 0; fi < 4; fi++) {
            if (this.canDropOnFoundation(cards[0], fi)) {
              // Extra bonus if it also enables an auto-move chain
              moves.push({
                score: 100,
                fromZone, fromIndex, fromCardIdx,
                toZone: 'foundation', toIndex: fi,
                label: `Move ${cards[0].id} to foundation`,
              });
            }
          }
        }

        // ── To tableau ──
        for (let tc = 0; tc < 8; tc++) {
          if (fromZone === 'tableau' && tc === fromIndex) continue;
          if (!this.canDropOnTableau(cards, tc)) continue;

          let score = 0;
          const destCol = this.tableau[tc];

          if (destCol.length === 0) {
            // Moving to empty column: useful but expensive — only prefer if moving a King
            // or freeing a free cell
            score = fromZone === 'freecell' ? 25 : (cards[0].rankValue === 13 ? 20 : 8);
          } else {
            score = 30;
            // Bonus: free cell card → tableau (frees a slot)
            if (fromZone === 'freecell') score += 25;
            // Bonus: uncovers a card below (buried card might be useful)
            if (fromZone === 'tableau' && fromCardIdx > 0) score += 8;
            // Bonus: moving a longer sequence is more efficient
            score += Math.min(cards.length - 1, 4) * 3;
            // Bonus: the card we'd uncover goes to foundation next turn
            if (fromZone === 'tableau' && fromCardIdx > 0) {
              const uncovered = this.tableau[fromIndex][fromCardIdx - 1];
              const uf = this.foundations.find(f => f.suit === uncovered.suit);
              if (uf && uncovered.rankValue === uf.cards.length + 1) score += 15;
            }
          }

          moves.push({
            score,
            fromZone, fromIndex, fromCardIdx,
            toZone: 'tableau', toIndex: tc,
            label: `Move ${cards[0].id}${cards.length > 1 ? `+${cards.length-1}` : ''} to column ${tc + 1}`,
          });
        }

        // ── To free cell (last resort, single cards only) ──
        if (cards.length === 1 && fromZone !== 'freecell') {
          const fi = this.freeCells.findIndex(c => c === null);
          if (fi >= 0 && this.canDropOnFreeCell(fi)) {
            moves.push({
              score: 2,
              fromZone, fromIndex, fromCardIdx,
              toZone: 'freecell', toIndex: fi,
              label: `Park ${cards[0].id} in free cell`,
            });
          }
        }
      };

      // Generate moves from tableau
      for (let ci = 0; ci < 8; ci++) {
        const col = this.tableau[ci];
        for (let cardIdx = 0; cardIdx < col.length; cardIdx++) {
          if (!this.canDragFromTableau(ci, cardIdx)) continue;
          evaluate(col.slice(cardIdx), 'tableau', ci, cardIdx);
        }
      }

      // Generate moves from free cells
      for (let ci = 0; ci < 4; ci++) {
        const card = this.freeCells[ci];
        if (!card) continue;
        evaluate([card], 'freecell', ci, 0);
      }

      this.dragPayload = saved;

      if (!moves.length) return null;
      moves.sort((a, b) => b.score - a.score);
      return moves[0];
    },

    showHint() {
      if (this.won) return;
      clearTimeout(this.hintTimeout);
      this.hint = this.computeHint();
      this.hintsUsed++;

      if (!this.hint) return;

      // Auto-clear after 3.5 s
      this.hintTimeout = setTimeout(() => { this.hint = null; }, 3500);
    },

    clearHint() {
      clearTimeout(this.hintTimeout);
      this.hint = null;
    },

    // Helpers to check if a card/slot is part of the active hint
    isHintSource(zone, index, cardIdx) {
      if (!this.hint || this.hint.fromZone !== zone || this.hint.fromIndex !== index) return false;
      if (zone === 'tableau') return cardIdx >= this.hint.fromCardIdx;
      return true; // freecell: single card
    },

    isHintTarget(zone, index) {
      if (!this.hint) return false;
      return this.hint.toZone === zone && this.hint.toIndex === index;
    },

    // ── Stats panel ───────────────────────────────────────────────────────
    openStats() {
      this.statsFilter = 'all';
      this.statsPage   = 0;
      this.showStats   = true;
    },

    closeStats() { this.showStats = false; },

    setFilter(f) {
      this.statsFilter = f;
      this.statsPage   = 0;
    },

    fmtResultTime(secs) { return fmtTime(secs); },
    fmtResultDate(iso)  { return fmtDate(iso); },

    async clearAllResults() {
      if (!this.db) return;
      if (!confirm('Delete all game history? This cannot be undone.')) return;
      // Clear by re-creating via delete-all loop
      const tx = this.db.transaction(RESULTS_STORE, 'readwrite');
      tx.objectStore(RESULTS_STORE).clear();
      await new Promise(r => { tx.oncomplete = r; });
      this.allResults = [];
    },

    // ── Keyboard ──────────────────────────────────────────────────────────
    onKeyDown(e) {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') { this.showStats = false; return; }
      if (this.showStats) return;
      if (e.key === 'n' || e.key === 'N') this.newGame();
      if (e.key === 'u' || e.key === 'U') this.undoMove();
    },

    // ── Confetti ──────────────────────────────────────────────────────────
    confettiStyle(n) {
      const colors = ['#f87171','#34d399','#60a5fa','#fbbf24','#a78bfa','#fb923c'];
      return {
        left:              `${((n * 137.5) % 100).toFixed(1)}%`,
        animationDelay:    `${((n * 0.17) % 2).toFixed(2)}s`,
        animationDuration: `${(1.5 + (n % 3) * 0.5).toFixed(1)}s`,
        background:        colors[n % colors.length],
      };
    },
  },
});
