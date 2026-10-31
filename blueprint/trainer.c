/*
 * Patio Solver blueprint trainer: heads-up no-limit hold'em, self-play.
 *
 * External-sampling Monte Carlo CFR (the Pluribus recipe):
 *   - Linear CFR: regrets and strategy sums are discounted by k/(k+1) at regular intervals
 *     during the first part of training, so early random play fades out.
 *   - Negative-regret pruning: after a warm-up, 95% of iterations skip actions whose regret
 *     is below a threshold (except on the river and for actions that end the hand).
 *   - Regrets are floored so pruned actions can come back.
 *   - Threads share the tables without locks (as Pluribus did).
 *
 * Abstraction (must match src/blueprint.js exactly):
 *   - Actions: per street and raise level, a list of pot fractions plus all-in (see --sizes).
 *   - Cards: preflop is lossless (169 classes). Flop and turn: 2-D buckets, first by EHS (the
 *     hand's average river percentile over every runout), then by current percentile within
 *     that EHS band. River: percentile buckets, finer at the top.
 *
 * Training runs in chunks: --minutes N trains for N minutes, then writes the checkpoint
 * (regrets + strategy sums) and the exported blueprint. Run again with the same flags and
 * the same checkpoint to continue.
 *
 * Build: gcc -O3 -march=native -ffp-contract=off -pthread -o blueprint/train blueprint/trainer.c -lm
 * (on a Mac: clang -O3 -ffp-contract=off -pthread -o blueprint/train blueprint/trainer.c)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>

#define NUM_COMBOS 1326
#define MAXA 8
#define MAXLV 6

/* ------------------------------------------------------------------ cards */
static uint8_t COMBO_HI[NUM_COMBOS], COMBO_LO[NUM_COMBOS], COMBO_CLASS[NUM_COMBOS];
static int16_t COMBO_INDEX[52 * 52];

static void init_combos(void) {
  int k = 0;
  for (int a = 51; a >= 1; a--)
    for (int b = a - 1; b >= 0; b--) {
      COMBO_HI[k] = a; COMBO_LO[k] = b;
      COMBO_INDEX[a * 52 + b] = k; COMBO_INDEX[b * 52 + a] = k;
      int ra = a >> 2, rb = b >> 2, row, col;
      if (ra == rb) { row = col = 12 - ra; }
      else if ((a & 3) == (b & 3)) { row = 12 - ra; col = 12 - rb; }
      else { row = 12 - rb; col = 12 - ra; }
      COMBO_CLASS[k] = row * 13 + col;
      k++;
    }
}

/* ---------------------------------------------------- evaluator (= engine.js) */
static int8_t STRAIGHT_HIGH[8192], HIGHBIT[8192];
static int32_t TOP5[8192];
static uint8_t POPCOUNT[8192];

static void init_eval(void) {
  for (int m = 0; m < 8192; m++) {
    int hi = -1;
    for (int r = 12; r >= 4; r--) if (((m >> (r - 4)) & 31) == 31) { hi = r; break; }
    if (hi < 0 && (m & 0x100f) == 0x100f) hi = 3;
    STRAIGHT_HIGH[m] = hi;
    int v = 0, k = 0, pc = 0, hb = -1;
    for (int r = 12; r >= 0; r--)
      if ((m >> r) & 1) { pc++; if (hb < 0) hb = r; if (k < 5) { v |= r << (4 * (4 - k)); k++; } }
    TOP5[m] = v; POPCOUNT[m] = pc; HIGHBIT[m] = hb;
  }
}

static inline int evaluate(const int *cards, int n) {
  int m[4] = {0, 0, 0, 0};
  for (int i = 0; i < n; i++) m[cards[i] & 3] |= 1 << (cards[i] >> 2);
  int m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
  int fm = -1;
  if (POPCOUNT[m0] >= 5) fm = m0; else if (POPCOUNT[m1] >= 5) fm = m1;
  else if (POPCOUNT[m2] >= 5) fm = m2; else if (POPCOUNT[m3] >= 5) fm = m3;
  if (fm >= 0) { int sf = STRAIGHT_HIGH[fm]; if (sf >= 0) return (8 << 20) | (sf << 16); }
  int any = m0 | m1 | m2 | m3, quads = m0 & m1 & m2 & m3;
  if (quads) { int q = HIGHBIT[quads]; return (7 << 20) | (q << 16) | (HIGHBIT[any & ~(1 << q)] << 12); }
  int trips = (m0 & m1 & m2) | (m0 & m1 & m3) | (m0 & m2 & m3) | (m1 & m2 & m3);
  int pairs = ((m0 & m1) | (m0 & m2) | (m0 & m3) | (m1 & m2) | (m1 & m3) | (m2 & m3)) & ~trips;
  if (trips) {
    int t = HIGHBIT[trips], rest = (trips & ~(1 << t)) | pairs;
    if (rest) return (6 << 20) | (t << 16) | (HIGHBIT[rest] << 12);
  }
  if (fm >= 0) return (5 << 20) | TOP5[fm];
  int st = STRAIGHT_HIGH[any];
  if (st >= 0) return (4 << 20) | (st << 16);
  if (trips) { int t = HIGHBIT[trips]; return (3 << 20) | (t << 16) | ((TOP5[any & ~(1 << t)] >> 12) << 8); }
  if (pairs) {
    int p1 = HIGHBIT[pairs], rest = pairs & ~(1 << p1);
    if (rest) { int p2 = HIGHBIT[rest]; return (2 << 20) | (p1 << 16) | (p2 << 12) | (HIGHBIT[any & ~(1 << p1) & ~(1 << p2)] << 8); }
    return (1 << 20) | (p1 << 16) | ((TOP5[any & ~(1 << p1)] >> 8) << 4);
  }
  return TOP5[any];
}

/* Percentile of each valid combo among the valid combos (ties share the middle rank), exactly
 * as engine.js percentiles(). */
static int cmp_i64(const void *a, const void *b) {
  int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
  return x < y ? -1 : x > y;
}
static void percentiles(const int32_t *scores, const int16_t *valid, int count, double *out, int64_t *keys) {
  for (int i = 0; i < count; i++) keys[i] = (int64_t)scores[valid[i]] * 2048 + valid[i];
  qsort(keys, count, sizeof(int64_t), cmp_i64);
  int i = 0;
  double denom = count - 1 > 1 ? count - 1 : 1;
  while (i < count) {
    int64_t s = keys[i] / 2048;
    int j = i;
    while (j < count && keys[j] / 2048 == s) j++;
    double p = (i + (j - i - 1) / 2.0) / denom;
    for (int x = i; x < j; x++) out[keys[x] % 2048] = p;
    i = j;
  }
}

/* ------------------------------------------------------- canonical boards */
static int PERMS[24][4];
static void init_perms(void) {
  int n = 0;
  for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) for (int c = 0; c < 4; c++) for (int d = 0; d < 4; d++) {
    if (a == b || a == c || a == d || b == c || b == d || c == d) continue;
    PERMS[n][0] = a; PERMS[n][1] = b; PERMS[n][2] = c; PERMS[n][3] = d; n++;
  }
}
/* Canonical key of a board: over the 24 suit relabelings, the smallest base-52 number made
 * from the relabeled cards sorted high to low. */
static int64_t canon_key(const int *cards, int n, int *permOut) {
  int64_t best = -1; int bp = 0;
  for (int p = 0; p < 24; p++) {
    int m[5];
    for (int i = 0; i < n; i++) m[i] = (cards[i] & ~3) | PERMS[p][cards[i] & 3];
    for (int i = 1; i < n; i++) { int v = m[i], j = i - 1; while (j >= 0 && m[j] < v) { m[j + 1] = m[j]; j--; } m[j + 1] = v; }
    int64_t key = 0;
    for (int i = 0; i < n; i++) key = key * 52 + m[i];
    if (best < 0 || key < best) { best = key; bp = p; }
  }
  *permOut = bp;
  return best;
}
static int64_t BINOM[53][6];
static void init_binom(void) {
  for (int n = 0; n <= 52; n++) { BINOM[n][0] = 1; for (int k = 1; k < 6; k++) BINOM[n][k] = n == 0 ? 0 : BINOM[n - 1][k - 1] + BINOM[n - 1][k]; }
}
/* colex rank of a set of distinct cards */
static inline int64_t colex(const int *cards, int n) {
  int s[5];
  for (int i = 0; i < n; i++) s[i] = cards[i];
  for (int i = 1; i < n; i++) { int v = s[i], j = i - 1; while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; } s[j + 1] = v; }
  int64_t r = 0;
  for (int i = 0; i < n; i++) r += BINOM[s[i]][i + 1];
  return r;
}

typedef struct {
  int n;               /* board size */
  int count;           /* canonical boards */
  int64_t *keys;       /* sorted canonical keys */
  int32_t *mult;       /* raw boards per canonical board */
  int64_t raw;         /* number of raw boards */
  int32_t *rawId;      /* colex -> canonical id */
  uint8_t *rawPerm;    /* colex -> perm */
  uint8_t *bucket;     /* canonical id * 1326 + combo */
} BoardSet;

static int cmp_key(const void *a, const void *b) { int64_t x = *(const int64_t *)a, y = *(const int64_t *)b; return x < y ? -1 : x > y; }
static int find_key(const BoardSet *bs, int64_t key) {
  int lo = 0, hi = bs->count - 1;
  while (lo <= hi) { int mid = (lo + hi) >> 1; if (bs->keys[mid] < key) lo = mid + 1; else if (bs->keys[mid] > key) hi = mid - 1; else return mid; }
  return -1;
}
static void decode_key(int64_t key, int n, int *cards) {
  for (int i = n - 1; i >= 0; i--) { cards[i] = (int)(key % 52); key /= 52; }
}

static void build_boardset(BoardSet *bs, int n) {
  bs->n = n;
  bs->raw = BINOM[52][n];
  bs->rawId = malloc(sizeof(int32_t) * bs->raw);
  bs->rawPerm = malloc(bs->raw);
  int64_t *rawKey = malloc(sizeof(int64_t) * bs->raw);
  int c[5];
  for (int i = 0; i < n; i++) c[i] = i;
  int64_t idx = 0;
  /* enumerate combinations in colex order: increment like an odometer on the sorted set */
  while (1) {
    int perm;
    int64_t key = canon_key(c, n, &perm);
    int64_t r = colex(c, n);
    rawKey[r] = key; bs->rawPerm[r] = perm; idx++;
    int i = 0;
    while (i < n && (i == n - 1 ? c[i] == 51 : c[i] + 1 == c[i + 1])) i++;
    if (i == n) break;
    c[i]++;
    for (int j = 0; j < i; j++) c[j] = j;
  }
  int64_t *sorted = malloc(sizeof(int64_t) * bs->raw);
  memcpy(sorted, rawKey, sizeof(int64_t) * bs->raw);
  qsort(sorted, bs->raw, sizeof(int64_t), cmp_key);
  int count = 0;
  for (int64_t i = 0; i < bs->raw; i++) if (i == 0 || sorted[i] != sorted[i - 1]) sorted[count++] = sorted[i];
  bs->count = count;
  bs->keys = realloc(sorted, sizeof(int64_t) * count);
  bs->mult = calloc(count, sizeof(int32_t));
  for (int64_t r = 0; r < bs->raw; r++) { int id = find_key(bs, rawKey[r]); bs->rawId[r] = id; bs->mult[id]++; }
  free(rawKey);
  bs->bucket = NULL;
}

/* ------------------------------------------------------------- features */
/* hs: percentile of each combo on the board. ehs: average river percentile over every runout
 * (n = 3: both remaining cards, n = 4: the river), as src/blueprint.js computes. */
static void board_features(const int *board, int n, double *hs, double *ehs) {
  int dead[52] = {0};
  for (int i = 0; i < n; i++) dead[board[i]] = 1;
  int buf[7];
  for (int i = 0; i < n; i++) buf[i] = board[i];
  int32_t *scores = malloc(sizeof(int32_t) * NUM_COMBOS);
  int16_t valid[NUM_COMBOS], valid2[NUM_COMBOS];
  int64_t keys[NUM_COMBOS];
  double tmp[NUM_COMBOS];
  int count = 0;
  for (int k = 0; k < NUM_COMBOS; k++) {
    hs[k] = -1; if (ehs) ehs[k] = -1;
    int a = COMBO_HI[k], b = COMBO_LO[k];
    if (dead[a] || dead[b]) continue;
    buf[n] = a; buf[n + 1] = b;
    scores[k] = evaluate(buf, n + 2);
    valid[count++] = k;
  }
  percentiles(scores, valid, count, hs, keys);
  if (ehs && n < 5) {
    double sum[NUM_COMBOS]; int cnt[NUM_COMBOS];
    memset(sum, 0, sizeof(sum)); memset(cnt, 0, sizeof(cnt));
    for (int t = 0; t < 52; t++) {
      if (dead[t]) continue;
      for (int r = (n == 3 ? t + 1 : t); r < (n == 3 ? 52 : t + 1); r++) {
        if (n == 3 && dead[r]) continue;
        buf[n] = t;
        if (n == 3) buf[n + 1] = r;
        int c2 = 0;
        for (int i = 0; i < count; i++) {
          int k = valid[i], a = COMBO_HI[k], b = COMBO_LO[k];
          if (a == t || b == t || (n == 3 && (a == r || b == r))) continue;
          buf[5] = a; buf[6] = b;
          scores[k] = evaluate(buf, 7);
          valid2[c2++] = k;
        }
        percentiles(scores, valid2, c2, tmp, keys);
        for (int i = 0; i < c2; i++) { int k = valid2[i]; sum[k] += tmp[k]; cnt[k]++; }
      }
    }
    for (int i = 0; i < count; i++) { int k = valid[i]; ehs[k] = cnt[k] ? sum[k] / cnt[k] : hs[k]; }
  }
  free(scores);
}

#define HBINS 65536
typedef struct {
  int ne, nh;          /* ehs bands x hs bands (river: ne = buckets, nh = 1) */
  double gamma;        /* skew of the ehs (or river hs) bands toward the top */
  double *eEdges;      /* ne - 1 */
  double *hEdges;      /* ne * (nh - 1) */
} BucketSpec;

static inline int hbin(double x) { int b = (int)(x * HBINS); return b < 0 ? 0 : b >= HBINS ? HBINS - 1 : b; }
static inline int count_le(const double *edges, int n, double x) { int c = 0; while (c < n && x >= edges[c]) c++; return c; }
static inline int bucket_of(const BucketSpec *s, double hs, double ehs) {
  if (s->nh <= 1) return count_le(s->eEdges, s->ne - 1, hs);
  int e = count_le(s->eEdges, s->ne - 1, ehs);
  return e * s->nh + count_le(s->hEdges + e * (s->nh - 1), s->nh - 1, hs);
}
/* Edges from a weighted histogram so band i holds mass m_i - m_{i-1}, m_i = 1 - (1 - i/n)^gamma. */
static void edges_from_hist(const double *hist, int n, double gamma, double *edges) {
  double total = 0;
  for (int b = 0; b < HBINS; b++) total += hist[b];
  double cum = 0; int e = 0, b = 0;
  for (int i = 1; i < n; i++) {
    double target = (1 - pow(1 - (double)i / n, gamma)) * total;
    while (b < HBINS && cum + hist[b] <= target) { cum += hist[b]; b++; }
    /* edge at the upper boundary of the bin where the target falls (at least one bin above the last edge) */
    double edge = (double)(b + 1) / HBINS;
    if (e > 0 && edge <= edges[e - 1]) edge = edges[e - 1] + 1.0 / HBINS;
    edges[e++] = edge;
  }
}

typedef struct { BoardSet *bs; int from, to; double *hsAll, *ehsAll; } FeatJob;
static void *feat_worker(void *arg) {
  FeatJob *j = arg;
  int cards[5];
  for (int id = j->from; id < j->to; id++) {
    decode_key(j->bs->keys[id], j->bs->n, cards);
    board_features(cards, j->bs->n, j->hsAll + (int64_t)id * NUM_COMBOS, j->ehsAll ? j->ehsAll + (int64_t)id * NUM_COMBOS : NULL);
  }
  return NULL;
}

/* Bucket tables take a minute or two to compute, so they are cached in blueprint/out/. */
static const char *CACHE_DIR = "blueprint/out";
static int load_buckets(BoardSet *bs, BucketSpec *spec) {
  char path[1024];
  snprintf(path, sizeof(path), "%s/buckets-%d-%dx%d-g%d.bin", CACHE_DIR, bs->n, spec->ne, spec->nh, (int)(spec->gamma * 1000));
  FILE *f = fopen(path, "rb");
  if (!f) return 0;
  int64_t N = (int64_t)bs->count * NUM_COMBOS;
  int ne = spec->ne > 1 ? spec->ne - 1 : 1, nh = spec->nh > 1 ? spec->ne * (spec->nh - 1) : 0;
  spec->eEdges = malloc(sizeof(double) * ne);
  spec->hEdges = nh ? malloc(sizeof(double) * nh) : NULL;
  bs->bucket = malloc(N);
  int ok = fread(spec->eEdges, sizeof(double), ne, f) == (size_t)ne && (!nh || fread(spec->hEdges, sizeof(double), nh, f) == (size_t)nh) && fread(bs->bucket, 1, N, f) == (size_t)N;
  fclose(f);
  if (!ok) { free(bs->bucket); bs->bucket = NULL; return 0; }
  return 1;
}
static void save_buckets(const BoardSet *bs, const BucketSpec *spec) {
  char path[1024], tmp[1100];
  snprintf(path, sizeof(path), "%s/buckets-%d-%dx%d-g%d.bin", CACHE_DIR, bs->n, spec->ne, spec->nh, (int)(spec->gamma * 1000));
  snprintf(tmp, sizeof(tmp), "%s.%d.tmp", path, (int)getpid());
  FILE *f = fopen(tmp, "wb");
  if (!f) return;
  int64_t N = (int64_t)bs->count * NUM_COMBOS;
  int ne = spec->ne > 1 ? spec->ne - 1 : 1, nh = spec->nh > 1 ? spec->ne * (spec->nh - 1) : 0;
  fwrite(spec->eEdges, sizeof(double), ne, f);
  if (nh) fwrite(spec->hEdges, sizeof(double), nh, f);
  fwrite(bs->bucket, 1, N, f);
  fclose(f);
  rename(tmp, path);
}

static void compute_buckets_raw(BoardSet *bs, BucketSpec *spec, int threads);
static void compute_buckets(BoardSet *bs, BucketSpec *spec, int threads) {
  if (load_buckets(bs, spec)) return;
  compute_buckets_raw(bs, spec, threads);
  save_buckets(bs, spec);
}
static void compute_buckets_raw(BoardSet *bs, BucketSpec *spec, int threads) {
  int64_t N = (int64_t)bs->count * NUM_COMBOS;
  double *hs = malloc(sizeof(double) * N);
  double *ehs = bs->n < 5 ? malloc(sizeof(double) * N) : NULL;
  pthread_t th[64]; FeatJob jobs[64];
  for (int t = 0; t < threads; t++) {
    jobs[t] = (FeatJob){ bs, (int)((int64_t)bs->count * t / threads), (int)((int64_t)bs->count * (t + 1) / threads), hs, ehs };
    pthread_create(&th[t], NULL, feat_worker, &jobs[t]);
  }
  for (int t = 0; t < threads; t++) pthread_join(th[t], NULL);
  double *hist = calloc(HBINS, sizeof(double));
  const double *primary = ehs ? ehs : hs;
  for (int64_t i = 0; i < N; i++) if (primary[i] >= 0) hist[hbin(primary[i])] += bs->mult[i / NUM_COMBOS];
  spec->eEdges = malloc(sizeof(double) * (spec->ne > 1 ? spec->ne - 1 : 1));
  edges_from_hist(hist, spec->ne, spec->gamma, spec->eEdges);
  spec->hEdges = NULL;
  if (spec->nh > 1) {
    spec->hEdges = malloc(sizeof(double) * spec->ne * (spec->nh - 1));
    double *h2 = calloc((size_t)HBINS * spec->ne, sizeof(double));
    for (int64_t i = 0; i < N; i++) if (ehs[i] >= 0) h2[(size_t)count_le(spec->eEdges, spec->ne - 1, ehs[i]) * HBINS + hbin(hs[i])] += bs->mult[i / NUM_COMBOS];
    for (int e = 0; e < spec->ne; e++) edges_from_hist(h2 + (size_t)e * HBINS, spec->nh, 1.0, spec->hEdges + e * (spec->nh - 1));
    free(h2);
  }
  free(hist);
  bs->bucket = malloc(N);
  for (int64_t i = 0; i < N; i++) bs->bucket[i] = hs[i] < 0 ? 255 : bucket_of(spec, hs[i], ehs ? ehs[i] : hs[i]);
  free(hs); free(ehs);
}


/* ----------------------------------------------------------------- tree */
#define MAXP 6
typedef struct {
  int players, stack, sb, bb;
  double allinFrac;
  int nlv[4];
  int nsz[4][MAXLV];
  double sz[4][MAXLV][MAXA];
  int nb[4];
} Config;

typedef struct {
  uint8_t player, street, nacts;
  char kind[MAXA];
  int32_t add[MAXA];
  int32_t child[MAXA]; /* >= 0 decision node, < 0: -(1 + terminal) */
  int64_t off;
} Node;
/* live: players still in (bit mask); one live player = everyone else folded */
typedef struct { int32_t commit[MAXP]; uint8_t live; } Term;

static Node *NODES; static int NNODES, CAPNODES;
static Term *TERMS; static int NTERMS, CAPTERMS;
static int64_t TOTAL;
static Config CFG;
static int ORDER[4][MAXP]; /* action order per street (preflop, then postflop) */

/* Seats: preflop order 0 .. n-1, so seat n-2 is the small blind and n-1 the big blind (heads-up:
 * seat 0 is the button / small blind). Postflop the blinds act first (heads-up: the big blind). */
static void init_order(void) {
  int n = CFG.players;
  for (int i = 0; i < n; i++) ORDER[0][i] = i;
  for (int s = 1; s < 4; s++) {
    if (n == 2) { ORDER[s][0] = 1; ORDER[s][1] = 0; continue; }
    ORDER[s][0] = n - 2; ORDER[s][1] = n - 1;
    for (int i = 0; i < n - 2; i++) ORDER[s][2 + i] = i;
  }
}

typedef struct { int street, bet[MAXP], commit[MAXP], folded[MAXP], acted[MAXP], raises, lastRaise; } St;

static int new_term(const St *st) {
  if (NTERMS == CAPTERMS) { CAPTERMS = CAPTERMS ? CAPTERMS * 2 : 1024; TERMS = realloc(TERMS, sizeof(Term) * CAPTERMS); }
  Term t; memset(&t, 0, sizeof(t));
  for (int i = 0; i < CFG.players; i++) { t.commit[i] = st->commit[i]; if (!st->folded[i]) t.live |= 1 << i; }
  TERMS[NTERMS] = t;
  return -(1 + NTERMS++);
}

/* next player to act after `from` on this street who hasn't acted since the last raise, or -1 */
static int next_actor(const St *st, int from) {
  int n = CFG.players, idx = 0;
  const int *ord = ORDER[st->street];
  for (int i = 0; i < n; i++) if (ord[i] == from) idx = i;
  for (int k = 1; k <= n; k++) {
    int q = ord[(idx + k) % n];
    if (!st->folded[q] && st->commit[q] < CFG.stack && !st->acted[q]) return q;
  }
  return -1;
}

static int build(St st, int p) {
  if (NNODES == CAPNODES) { CAPNODES = CAPNODES ? CAPNODES * 2 : 1024; NODES = realloc(NODES, sizeof(Node) * CAPNODES); }
  int id = NNODES++;
  Node nd; memset(&nd, 0, sizeof(nd));
  int N = CFG.players, S = CFG.stack;
  int maxBet = 0, pot = 0;
  for (int i = 0; i < N; i++) { if (st.bet[i] > maxBet) maxBet = st.bet[i]; pot += st.commit[i]; }
  int facing = maxBet - st.bet[p], rem = S - st.commit[p];
  int n = 0;
  if (facing > 0) { nd.kind[n] = 'f'; nd.add[n++] = 0; nd.kind[n] = 'c'; nd.add[n++] = facing < rem ? facing : rem; }
  else { nd.kind[n] = 'k'; nd.add[n++] = 0; }
  int others = 0;
  for (int i = 0; i < N; i++) if (i != p && !st.folded[i] && st.commit[i] < S) others = 1;
  if (rem > facing && others && st.raises < CFG.nlv[st.street]) {
    int potAfter = pot + facing;
    for (int i = 0; i < CFG.nsz[st.street][st.raises]; i++) {
      double f = CFG.sz[st.street][st.raises][i];
      int to = maxBet + (int)floor(f * potAfter + 0.5);
      int minInc = st.lastRaise > CFG.bb ? st.lastRaise : CFG.bb;
      if (to < maxBet + minInc) to = maxBet + minInc;
      int add = to - st.bet[p];
      if (add > CFG.allinFrac * rem) continue;
      int dup = 0;
      for (int j = 0; j < n; j++) if (nd.kind[j] == 'r' && nd.add[j] == add) dup = 1;
      if (dup) continue;
      nd.kind[n] = 'r'; nd.add[n++] = add;
    }
    nd.kind[n] = 'a'; nd.add[n++] = rem;
  }
  nd.player = p; nd.street = st.street; nd.nacts = n;
  nd.off = TOTAL; TOTAL += (int64_t)n * CFG.nb[st.street];
  NODES[id] = nd;
  for (int i = 0; i < n; i++) {
    char k = nd.kind[i]; int amt = nd.add[i];
    St s2 = st;
    if (k == 'f') s2.folded[p] = 1;
    else { s2.bet[p] += amt; s2.commit[p] += amt; }
    s2.acted[p] = 1;
    if (k == 'r' || k == 'a') {
      int inc = s2.bet[p] - maxBet;
      if (inc > s2.lastRaise) s2.lastRaise = inc;
      s2.raises++;
      for (int q = 0; q < N; q++) if (q != p) s2.acted[q] = 0;
    }
    int live = 0;
    for (int q = 0; q < N; q++) if (!s2.folded[q]) live++;
    int ch;
    if (live == 1) ch = new_term(&s2);
    else {
      int nx = next_actor(&s2, p);
      if (nx >= 0) ch = build(s2, nx);
      else {
        int canAct = 0;
        for (int q = 0; q < N; q++) if (!s2.folded[q] && s2.commit[q] < S) canAct++;
        if (st.street == 3 || canAct <= 1) ch = new_term(&s2);
        else {
          St s3 = s2;
          s3.street = st.street + 1; s3.raises = 0; s3.lastRaise = 0;
          for (int q = 0; q < N; q++) { s3.bet[q] = 0; s3.acted[q] = 0; }
          int first = next_actor(&s3, ORDER[s3.street][N - 1]);
          ch = build(s3, first);
        }
      }
    }
    NODES[id].child[i] = ch;
  }
  return id;
}

/* FNV-1a over the tree, so the JS side can check it rebuilt the same tree */
static uint32_t tree_hash(void) {
  uint32_t h = 2166136261u;
#define MIX(x) do { uint32_t v_ = (uint32_t)(x); for (int b_ = 0; b_ < 4; b_++) { h ^= (v_ >> (8 * b_)) & 255; h *= 16777619u; } } while (0)
  for (int i = 0; i < NNODES; i++) {
    MIX(NODES[i].player); MIX(NODES[i].street); MIX(NODES[i].nacts);
    for (int a = 0; a < NODES[i].nacts; a++) { MIX(NODES[i].kind[a]); MIX(NODES[i].add[a]); MIX(NODES[i].child[a]); }
  }
  return h;
}

/* ---------------------------------------------------------------- MCCFR */
static float *REG;      /* regrets */
static double *SSUM;    /* strategy sums */
static BoardSet B3, B4, B5;
static double PRUNE_T = -3e6, REG_FLOOR = -3.1e6;
static volatile int64_t ITER = 0;   /* completed iterations (one traversal per seat) */
static int64_t PRUNE_AFTER = 2000000;

typedef struct { uint64_t s[2]; } Rng;
static inline uint64_t rnext(Rng *r) {
  uint64_t s1 = r->s[0]; const uint64_t s0 = r->s[1];
  r->s[0] = s0; s1 ^= s1 << 23; r->s[1] = s1 ^ s0 ^ (s1 >> 17) ^ (s0 >> 26);
  return r->s[1] + s0;
}
static inline double runif(Rng *r) { return (rnext(r) >> 11) * (1.0 / 9007199254740992.0); }

typedef struct { uint8_t bucket[MAXP][4]; int32_t score[MAXP]; int prune; } Deal;

static inline int board_id(const BoardSet *bs, const int *board, const int **perm) {
  int64_t r = colex(board, bs->n);
  *perm = PERMS[bs->rawPerm[r]];
  return bs->rawId[r];
}
static inline int lookup_bucket(const BoardSet *bs, int id, const int *P, int a, int b) {
  int ma = (a & ~3) | P[a & 3], mb = (b & ~3) | P[b & 3];
  return bs->bucket[(int64_t)id * NUM_COMBOS + COMBO_INDEX[ma * 52 + mb]];
}
/* bucket of hole cards (a, b) on a board of n cards */
static inline int board_bucket(const BoardSet *bs, const int *board, int a, int b) {
  const int *P; int id = board_id(bs, board, &P);
  return lookup_bucket(bs, id, P, a, b);
}

static void deal(Rng *r, Deal *d) {
  int N = CFG.players, deck[52], need = 2 * N + 5;
  for (int i = 0; i < 52; i++) deck[i] = i;
  for (int i = 0; i < need; i++) { int j = i + (int)(rnext(r) % (uint64_t)(52 - i)); int t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
  int *bd = deck + 2 * N;
  const int *P3, *P4, *P5;
  int i3 = board_id(&B3, bd, &P3), i4 = board_id(&B4, bd, &P4), i5 = board_id(&B5, bd, &P5);
  int c[7];
  for (int i = 0; i < 5; i++) c[i] = bd[i];
  for (int p = 0; p < N; p++) {
    int a = deck[2 * p], b = deck[2 * p + 1];
    d->bucket[p][0] = COMBO_CLASS[COMBO_INDEX[a * 52 + b]];
    d->bucket[p][1] = lookup_bucket(&B3, i3, P3, a, b);
    d->bucket[p][2] = lookup_bucket(&B4, i4, P4, a, b);
    d->bucket[p][3] = lookup_bucket(&B5, i5, P5, a, b);
    c[5] = a; c[6] = b;
    d->score[p] = evaluate(c, 7);
  }
}

static inline double term_value(const Term *t, int p, const Deal *d) {
  int N = CFG.players, pot = 0;
  for (int i = 0; i < N; i++) pot += t->commit[i];
  if (!((t->live >> p) & 1)) return -t->commit[p];
  int best = -1, nwin = 0;
  for (int i = 0; i < N; i++) {
    if (!((t->live >> i) & 1)) continue;
    if (d->score[i] > best) { best = d->score[i]; nwin = 1; } else if (d->score[i] == best) nwin++;
  }
  if ((t->live & (t->live - 1)) == 0) return pot - t->commit[p]; /* everyone else folded */
  return (d->score[p] == best ? (double)pot / nwin : 0) - t->commit[p];
}

static inline void regret_match(const float *r, int n, double *s) {
  double tot = 0;
  for (int a = 0; a < n; a++) { s[a] = r[a] > 0 ? r[a] : 0; tot += s[a]; }
  if (tot > 0) for (int a = 0; a < n; a++) s[a] /= tot;
  else for (int a = 0; a < n; a++) s[a] = 1.0 / n;
}

static double traverse(int nid, int p, const Deal *d, Rng *r) {
  const Node *nd = &NODES[nid];
  int n = nd->nacts;
  int64_t base = nd->off + (int64_t)d->bucket[nd->player][nd->street] * n;
  float *rg = REG + base;
  double s[MAXA];
  regret_match(rg, n, s);
  if (nd->player == p) {
    double v[MAXA], ev = 0;
    int explored[MAXA];
    for (int a = 0; a < n; a++) {
      int ch = nd->child[a];
      explored[a] = !d->prune || rg[a] > PRUNE_T || ch < 0 || nd->street == 3;
      if (!explored[a]) { v[a] = 0; continue; }
      v[a] = ch < 0 ? term_value(&TERMS[-1 - ch], p, d) : traverse(ch, p, d, r);
      ev += s[a] * v[a];
    }
    for (int a = 0; a < n; a++) {
      if (!explored[a]) continue;
      float x = rg[a] + (float)(v[a] - ev);
      rg[a] = x < REG_FLOOR ? (float)REG_FLOOR : x;
    }
    return ev;
  }
  double *ss = SSUM + base;
  for (int a = 0; a < n; a++) ss[a] += s[a];
  double u = runif(r), c = 0;
  int a = n - 1;
  for (int i = 0; i < n; i++) { c += s[i]; if (u < c) { a = i; break; } }
  int ch = nd->child[a];
  return ch < 0 ? term_value(&TERMS[-1 - ch], p, d) : traverse(ch, p, d, r);
}

typedef struct { int64_t iters; uint64_t seed; double ev[MAXP]; } Job;
static void *train_worker(void *arg) {
  Job *j = arg;
  Rng r = { { j->seed * 0x9E3779B97F4A7C15ull + 1, (j->seed + 7) * 0xC2B2AE3D27D4EB4Full + 3 } };
  for (int i = 0; i < 20; i++) rnext(&r);
  Deal d;
  for (int64_t it = 0; it < j->iters; it++) {
    int prune = ITER > PRUNE_AFTER && runif(&r) < 0.95;
    for (int p = 0; p < CFG.players; p++) {
      deal(&r, &d);
      d.prune = prune;
      j->ev[p] += traverse(0, p, &d, &r);
    }
  }
  return NULL;
}

/* ----------------------------------------------------------- persistence */
static uint32_t CONFIG_HASH;
static int save_checkpoint(const char *path, int64_t iters, int64_t disc) {
  char tmp[1024]; snprintf(tmp, sizeof(tmp), "%s.tmp", path);
  FILE *f = fopen(tmp, "wb");
  if (!f) { perror(tmp); return -1; }
  uint32_t magic = 0x50534350; /* PSCP */
  fwrite(&magic, 4, 1, f); fwrite(&CONFIG_HASH, 4, 1, f);
  fwrite(&iters, 8, 1, f); fwrite(&disc, 8, 1, f); fwrite(&TOTAL, 8, 1, f);
  int64_t done = 0, chunk = 1 << 22;
  while (done < TOTAL) { int64_t m = TOTAL - done < chunk ? TOTAL - done : chunk; if (fwrite(REG + done, sizeof(float), m, f) != (size_t)m) { fclose(f); return -1; } done += m; }
  done = 0;
  while (done < TOTAL) { int64_t m = TOTAL - done < chunk ? TOTAL - done : chunk; if (fwrite(SSUM + done, sizeof(double), m, f) != (size_t)m) { fclose(f); return -1; } done += m; }
  if (fclose(f)) return -1;
  return rename(tmp, path);
}
static int load_checkpoint(const char *path, int64_t *iters, int64_t *disc) {
  FILE *f = fopen(path, "rb");
  if (!f) return 0;
  uint32_t magic, h; int64_t tot;
  if (fread(&magic, 4, 1, f) != 1 || magic != 0x50534350 || fread(&h, 4, 1, f) != 1) { fclose(f); fprintf(stderr, "bad checkpoint\n"); exit(1); }
  if (h != CONFIG_HASH) { fclose(f); fprintf(stderr, "checkpoint was trained with a different config (hash %08x, now %08x)\n", h, CONFIG_HASH); exit(1); }
  if (fread(iters, 8, 1, f) != 1 || fread(disc, 8, 1, f) != 1 || fread(&tot, 8, 1, f) != 1 || tot != TOTAL) { fclose(f); fprintf(stderr, "bad checkpoint size\n"); exit(1); }
  if (fread(REG, sizeof(float), TOTAL, f) != (size_t)TOTAL || fread(SSUM, sizeof(double), TOTAL, f) != (size_t)TOTAL) { fclose(f); fprintf(stderr, "short checkpoint\n"); exit(1); }
  fclose(f);
  return 1;
}

static char SIZES_STR[2048];
static BucketSpec SPEC[4];
static int EXPORT_STREETS = 4; /* export strategies for streets below this (others left out of the file) */

static void json_edges(FILE *f, const double *e, int n) {
  fputc('[', f);
  for (int i = 0; i < n; i++) fprintf(f, "%s%.17g", i ? "," : "", e[i]);
  fputc(']', f);
}

/* Blueprint file for src/blueprint.js:
 *   "PSBP" u32 version, u32 json length, JSON header,
 *   flop canonical keys (count x int32), flop bucket table (count x 1326 u8),
 *   strategy: for every node in tree order whose street < exportStreets, for every bucket,
 *   nacts u8 (sum 255); then confidence for the same infosets, u8 = round(8 * log2(1 + strategy mass)). */
static int export_blueprint(const char *path, int64_t iters) {
  char tmp[1024]; snprintf(tmp, sizeof(tmp), "%s.tmp", path);
  FILE *f = fopen(tmp, "wb");
  if (!f) { perror(tmp); return -1; }
  int64_t outTotal = 0, outInfo = 0;
  for (int i = 0; i < NNODES; i++) if (NODES[i].street < EXPORT_STREETS) { outTotal += (int64_t)NODES[i].nacts * CFG.nb[NODES[i].street]; outInfo += CFG.nb[NODES[i].street]; }
  char *json; size_t jlen;
  FILE *jf = open_memstream(&json, &jlen);
  fprintf(jf, "{\"game\":\"nlhe\",\"players\":%d,\"stack\":%d,\"sb\":%d,\"bb\":%d,\"allinFrac\":%.17g,\"sizes\":\"%s\",\"nb\":[%d,%d,%d,%d],",
          CFG.players, CFG.stack, CFG.sb, CFG.bb, CFG.allinFrac, SIZES_STR, CFG.nb[0], CFG.nb[1], CFG.nb[2], CFG.nb[3]);
  fprintf(jf, "\"nodes\":%d,\"total\":%lld,\"treeHash\":%u,\"iterations\":%lld,\"flopBoards\":%d,\"exportStreets\":%d,\"exportTotal\":%lld,\"exportInfosets\":%lld,",
          NNODES, (long long)TOTAL, tree_hash(), (long long)iters, B3.count, EXPORT_STREETS, (long long)outTotal, (long long)outInfo);
  for (int s = 1; s <= 3; s++) {
    fprintf(jf, "\"b%d\":{\"ne\":%d,\"nh\":%d,\"e\":", s, SPEC[s].ne, SPEC[s].nh);
    json_edges(jf, SPEC[s].eEdges, SPEC[s].ne - 1);
    fprintf(jf, ",\"h\":");
    if (SPEC[s].nh > 1) json_edges(jf, SPEC[s].hEdges, SPEC[s].ne * (SPEC[s].nh - 1)); else fprintf(jf, "[]");
    fprintf(jf, "}%s", s < 3 ? "," : "");
  }
  fprintf(jf, ",\"trained\":%ld}", (long)time(NULL));
  fclose(jf);
  uint32_t magic = 0x50425350, ver = 2, jl = (uint32_t)jlen; /* "PSBP" */
  fwrite(&magic, 4, 1, f); fwrite(&ver, 4, 1, f); fwrite(&jl, 4, 1, f); fwrite(json, 1, jlen, f);
  free(json);
  for (int i = 0; i < B3.count; i++) { int32_t k = (int32_t)B3.keys[i]; fwrite(&k, 4, 1, f); }
  fwrite(B3.bucket, 1, (size_t)B3.count * NUM_COMBOS, f);
  uint8_t *out = malloc(outTotal + 1), *conf = malloc(outInfo + 1);
  int64_t oi = 0, ci = 0;
  for (int i = 0; i < NNODES; i++) {
    const Node *nd = &NODES[i];
    if (nd->street >= EXPORT_STREETS) continue;
    int n = nd->nacts;
    for (int b = 0; b < CFG.nb[nd->street]; b++) {
      int64_t base = nd->off + (int64_t)b * n;
      double tot = 0, s[MAXA];
      for (int a = 0; a < n; a++) tot += SSUM[base + a];
      if (tot > 0) for (int a = 0; a < n; a++) s[a] = SSUM[base + a] / tot;
      else regret_match(REG + base, n, s);
      int q[MAXA], used = 0; double rem[MAXA];
      for (int a = 0; a < n; a++) { double x = s[a] * 255; q[a] = (int)floor(x); rem[a] = x - q[a]; used += q[a]; }
      while (used < 255) { int bi = 0; for (int a = 1; a < n; a++) if (rem[a] > rem[bi]) bi = a; q[bi]++; rem[bi] = -1; used++; }
      for (int a = 0; a < n; a++) out[oi++] = (uint8_t)q[a];
      double c = 8 * log2(1 + tot);
      conf[ci++] = c > 255 ? 255 : (uint8_t)floor(c + 0.5);
    }
  }
  fwrite(out, 1, oi, f);
  fwrite(conf, 1, ci, f);
  free(out); free(conf);
  if (fclose(f)) return -1;
  return rename(tmp, path);
}

/* ---------------------------------------------------------------- main */
static void parse_sizes(const char *s) {
  /* streets separated by '|', raise levels by '/', fractions by ',' ; empty level = all-in only */
  strncpy(SIZES_STR, s, sizeof(SIZES_STR) - 1);
  int st = 0, lv = 0;
  memset(CFG.nlv, 0, sizeof(CFG.nlv)); memset(CFG.nsz, 0, sizeof(CFG.nsz));
  const char *p = s;
  CFG.nlv[0] = 1;
  while (*p) {
    if (*p == '|') { st++; lv = 0; CFG.nlv[st] = 1; p++; continue; }
    if (*p == '/') { lv++; CFG.nlv[st] = lv + 1; p++; continue; }
    if (*p == ',') { p++; continue; }
    char *end; double v = strtod(p, &end);
    if (end == p) { fprintf(stderr, "bad --sizes at '%s'\n", p); exit(1); }
    CFG.sz[st][lv][CFG.nsz[st][lv]++] = v;
    p = end;
  }
  if (st != 3) { fprintf(stderr, "--sizes needs 4 streets\n"); exit(1); }
}

static double now_sec(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }

int main(int argc, char **argv) {
  const char *sizes = "0.5,0.75,1.25/0.8,1.3/0.6/|0.33,0.66,1/0.6/|0.33,0.66,1/0.6/|0.33,0.66,1/0.6/";
  const char *ckpt = "blueprint/out/checkpoint.bin", *outp = "blueprint/out/blueprint.bin";
  double minutes = 1; int threads = 4; int treeOnly = 0, dumpN = 0;
  int64_t discEvery = 2000000, lcfrUntil = 200000000, saveEvery = 0;
  CFG.players = 2; CFG.stack = 1000; CFG.sb = 5; CFG.bb = 10; CFG.allinFrac = 0.6;
  SPEC[1] = (BucketSpec){ 24, 4, 1.25, NULL, NULL };
  SPEC[2] = (BucketSpec){ 24, 4, 1.25, NULL, NULL };
  SPEC[3] = (BucketSpec){ 64, 1, 1.6, NULL, NULL };
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : "";
    if (!strcmp(a, "--sizes")) { sizes = v; i++; }
    else if (!strcmp(a, "--players")) { CFG.players = atoi(v); i++; }
    else if (!strcmp(a, "--minutes")) { minutes = atof(v); i++; }
    else if (!strcmp(a, "--threads")) { threads = atoi(v); i++; }
    else if (!strcmp(a, "--checkpoint")) { ckpt = v; i++; }
    else if (!strcmp(a, "--out")) { outp = v; i++; }
    else if (!strcmp(a, "--stack")) { CFG.stack = atoi(v); i++; }
    else if (!strcmp(a, "--flop")) { sscanf(v, "%dx%d", &SPEC[1].ne, &SPEC[1].nh); i++; }
    else if (!strcmp(a, "--turn")) { sscanf(v, "%dx%d", &SPEC[2].ne, &SPEC[2].nh); i++; }
    else if (!strcmp(a, "--river")) { SPEC[3].ne = atoi(v); SPEC[3].nh = 1; i++; }
    else if (!strcmp(a, "--disc-every")) { discEvery = atoll(v); i++; }
    else if (!strcmp(a, "--lcfr-until")) { lcfrUntil = atoll(v); i++; }
    else if (!strcmp(a, "--prune-after")) { PRUNE_AFTER = atoll(v); i++; }
    else if (!strcmp(a, "--prune")) { PRUNE_T = atof(v); REG_FLOOR = PRUNE_T * 1.03; i++; }
    else if (!strcmp(a, "--save-every")) { saveEvery = atoll(v); i++; }
    else if (!strcmp(a, "--export-streets")) { EXPORT_STREETS = atoi(v); i++; }
    else if (!strcmp(a, "--tree")) treeOnly = 1;
    else if (!strcmp(a, "--dump-buckets")) { dumpN = atoi(v); i++; }
    else { fprintf(stderr, "unknown flag %s\n", a); return 1; }
  }
  if (CFG.players < 2 || CFG.players > MAXP) { fprintf(stderr, "--players 2..%d\n", MAXP); return 1; }
  parse_sizes(sizes);
  CFG.nb[0] = 169; CFG.nb[1] = SPEC[1].ne * SPEC[1].nh; CFG.nb[2] = SPEC[2].ne * SPEC[2].nh; CFG.nb[3] = SPEC[3].ne;
  for (int s = 1; s < 4; s++) if (CFG.nb[s] > 255) { fprintf(stderr, "at most 255 buckets per street\n"); return 1; }
  init_combos(); init_eval(); init_perms(); init_binom(); init_order();

  St root; memset(&root, 0, sizeof(root));
  root.bet[CFG.players - 2] = root.commit[CFG.players - 2] = CFG.sb;
  root.bet[CFG.players - 1] = root.commit[CFG.players - 1] = CFG.bb;
  root.lastRaise = CFG.bb;
  build(root, 0);
  int perSt[4] = {0}; for (int i = 0; i < NNODES; i++) perSt[NODES[i].street]++;
  CONFIG_HASH = tree_hash();
  for (int s = 0; s < 4; s++) CONFIG_HASH = CONFIG_HASH * 31 + CFG.nb[s];
  for (int s = 1; s < 4; s++) CONFIG_HASH = CONFIG_HASH * 31 + (uint32_t)(SPEC[s].gamma * 1000) + SPEC[s].ne * 7 + SPEC[s].nh;
  CONFIG_HASH = CONFIG_HASH * 31 + CFG.players;
  fprintf(stderr, "tree: %d players, %d nodes (pre %d, flop %d, turn %d, river %d), %d terminals, %lld infoset-actions (%.0f MB), hash %08x\n",
          CFG.players, NNODES, perSt[0], perSt[1], perSt[2], perSt[3], NTERMS, (long long)TOTAL, TOTAL * 12.0 / 1e6, tree_hash());
  if (treeOnly) return 0;

  double t0 = now_sec();
  build_boardset(&B3, 3); build_boardset(&B4, 4); build_boardset(&B5, 5);
  fprintf(stderr, "boards: flop %d, turn %d, river %d canonical (%.1fs)\n", B3.count, B4.count, B5.count, now_sec() - t0);
  t0 = now_sec();
  compute_buckets(&B5, &SPEC[3], threads); fprintf(stderr, "river buckets %.1fs\n", now_sec() - t0); t0 = now_sec();
  compute_buckets(&B4, &SPEC[2], threads); fprintf(stderr, "turn buckets %.1fs\n", now_sec() - t0); t0 = now_sec();
  compute_buckets(&B3, &SPEC[1], threads); fprintf(stderr, "flop buckets %.1fs\n", now_sec() - t0);

  if (dumpN > 0) {
    /* random hands with their buckets, for the JS consistency test */
    Rng r = { { 12345, 67890 } };
    for (int i = 0; i < dumpN; i++) {
      int deck[52];
      for (int j = 0; j < 52; j++) deck[j] = j;
      for (int j = 0; j < 7; j++) { int x = j + (int)(rnext(&r) % (uint64_t)(52 - j)); int t = deck[j]; deck[j] = deck[x]; deck[x] = t; }
      int *h = deck, *bd = deck + 2;
      printf("%d %d %d %d %d %d %d %d %d %d %d\n", h[0], h[1], bd[0], bd[1], bd[2], bd[3], bd[4],
             COMBO_CLASS[COMBO_INDEX[h[0] * 52 + h[1]]], board_bucket(&B3, bd, h[0], h[1]), board_bucket(&B4, bd, h[0], h[1]), board_bucket(&B5, bd, h[0], h[1]));
    }
    return 0;
  }
  REG = calloc(TOTAL, sizeof(float));
  SSUM = calloc(TOTAL, sizeof(double));
  if (!REG || !SSUM) { fprintf(stderr, "out of memory\n"); return 1; }
  int64_t iters = 0, disc = 0;
  if (load_checkpoint(ckpt, &iters, &disc)) fprintf(stderr, "resumed at %lld iterations\n", (long long)iters);
  ITER = iters;

  double start = now_sec(), lastLog = start, lastSave = start;
  int64_t epoch = 100000;
  uint64_t seedBase = (uint64_t)time(NULL) ^ ((uint64_t)iters << 20);
  double evs[MAXP] = {0}; int64_t evn = 0;
  while (now_sec() - start < minutes * 60) {
    pthread_t th[64]; Job jobs[64];
    int64_t per = epoch / threads;
    for (int t = 0; t < threads; t++) { memset(&jobs[t], 0, sizeof(Job)); jobs[t].iters = per; jobs[t].seed = seedBase + (uint64_t)iters * 131 + t * 7919; pthread_create(&th[t], NULL, train_worker, &jobs[t]); }
    for (int t = 0; t < threads; t++) { pthread_join(th[t], NULL); for (int q = 0; q < CFG.players; q++) evs[q] += jobs[t].ev[q]; }
    iters += per * threads; evn += per * threads; ITER = iters;
    /* Linear CFR: discount everything by k/(k+1) at each interval while iters < lcfrUntil */
    while (iters < lcfrUntil && iters / discEvery > disc) {
      disc++;
      double dk = (double)disc / (disc + 1);
      for (int64_t i = 0; i < TOTAL; i++) { REG[i] *= (float)dk; SSUM[i] *= dk; }
    }
    double tn = now_sec();
    if (tn - lastLog > 60) {
      fprintf(stderr, "%lld iterations, %.0f it/s, ev by seat (bb/hand):", (long long)iters, evn / (tn - lastLog));
      for (int q = 0; q < CFG.players; q++) fprintf(stderr, " %.3f", evs[q] / evn / CFG.bb);
      fprintf(stderr, "\n");
      lastLog = tn; for (int q = 0; q < CFG.players; q++) evs[q] = 0; evn = 0;
    }
    if (saveEvery > 0 && tn - lastSave > saveEvery * 60) {
      save_checkpoint(ckpt, iters, disc); export_blueprint(outp, iters); lastSave = tn;
      fprintf(stderr, "saved at %lld iterations\n", (long long)iters);
    }
  }
  if (save_checkpoint(ckpt, iters, disc)) { fprintf(stderr, "checkpoint write failed\n"); return 1; }
  if (export_blueprint(outp, iters)) { fprintf(stderr, "export failed\n"); return 1; }
  fprintf(stderr, "done: %lld iterations total, checkpoint %s, blueprint %s\n", (long long)iters, ckpt, outp);
  return 0;
}
