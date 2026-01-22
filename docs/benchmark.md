# EP Extraction Worker Benchmarks

## Test Commands

```bash
# Quick test (3 URLs, single run)
npm run test:browser:verbose \
  "https://embedsports.top/embed/echo/sa20-eliminator-royals-vs-super-kings-cricket-1/1" \
  "https://embedsports.top/embed/charlie/afghanistan-vs-west-indies-1629473869/1" \
  "https://embedsports.top/embed/charlie/sri-lanka-vs-england-1629473866/1"

# Stress test (3 URLs, 3 repetitions each)
npm run test:browser -- --repeat 3 \
  "https://embedsports.top/embed/echo/sa20-eliminator-royals-vs-super-kings-cricket-1/1" \
  "https://embedsports.top/embed/charlie/afghanistan-vs-west-indies-1629473869/1" \
  "https://embedsports.top/embed/charlie/sri-lanka-vs-england-1629473866/1"

# Concurrent test
npm run test:browser -- --repeat 3 --concurrent 2 "url1" "url2" "url3"
```

## Getting Fresh Embed URLs

Embed URLs contain time-sensitive tokens. Get current ones from ep-live-events logs:

```bash
docker logs ep-live-events 2>&1 | grep "Successfully extracted"
```

---

## Benchmark: 2025-01-22 (Post-Optimization)

### Test Configuration
- URLs: 3 unique embeds (echo, charlie sources)
- Repetitions: 3x each (9 total extractions)
- Concurrent: 1

### Results

| Metric | Value |
|--------|-------|
| Success Rate | 100% (9/9) |
| Avg Duration | 2.74s |
| Blocked Requests | 11.5% (63/546) |

### Per-Embed Breakdown

| Source | Avg Duration | Notes |
|--------|--------------|-------|
| echo | ~3.0s | More variable |
| charlie | ~2.6s | Consistent |

### Observations

1. **No clicking required** - All embeds auto-triggered m3u8 on page load
2. **Bottleneck is network** - `page.goto()` dominates extraction time
3. **Click optimizations unused** - Would only help embeds requiring play button interaction

---

## Optimization History

### 2025-01-22: Bug Fixes & Performance

**Changes:**
- Fixed setTimeout memory leak (clear timeout on m3u8 found)
- Fixed cookie capture race condition (capture before route.abort)
- Fixed multiple m3u8 race condition (set resolved immediately)
- Added graceful shutdown (SIGTERM/SIGINT handlers)
- Reduced settle time: 2000ms → 500ms
- Reduced click timeout: 2000ms → 500ms
- Parallelized frame clicking with Promise.all()
- Consolidated BLOCK_PATTERNS testing (single pass)
- Optimized player detection with single regex
- Added browser disconnect recovery

**Impact:**
- Correctness: Fixed memory leaks and race conditions
- Performance: Minimal change (~2.7s) because m3u8 found during page load
- Reliability: Better crash recovery

---

## Baseline Reference (Pre-Optimization)

| Metric | Value |
|--------|-------|
| Success Rate | 100% |
| Avg Duration | 2.68s |
| Blocked Requests | 10.9% (19/174) |

---

## Success Criteria

For any future optimization:
- [ ] 100% success rate maintained
- [ ] Duration ≤ baseline or justified regression
- [ ] Unit tests pass: `npm run test:run`
