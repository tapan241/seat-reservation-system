import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
const SHOW_NAME = `Concert Show - ${Date.now()}`;

const ADMIN_TOKEN = process.env.STRESS_ADMIN_TOKEN || 'admin_test';
const ROWS = parseInt(process.env.STRESS_TOTAL_ROWS || '5', 10);
const COLS = parseInt(process.env.STRESS_SEATS_PER_ROW || '10', 10);
const HOT_SEAT_USERS = parseInt(process.env.STRESS_HOT_SEAT_USERS || '50', 10);
const QUOTA_REQUESTS = parseInt(process.env.STRESS_QUOTA_USER_REQUESTS || '10', 10);
const RANDOM_USERS = parseInt(process.env.STRESS_RANDOM_USERS || '100', 10);
const BATCH_SIZE = 200;

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// helper to split array into chunks to prevent Node OOM
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunked: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunked.push(array.slice(i, i + size));
  }
  return chunked;
}

async function runStressTest() {
  log('Starting Concurrency Stress Test');

  // Generate Seat Layout (A1...A10, B1...B10)
  const allSeats: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    const rowChar = String.fromCharCode(65 + r);
    for (let c = 1; c <= COLS; c++) {
      allSeats.push(`${rowChar}${c}`);
    }
  }

  if (allSeats.length < 20) {
    throw new Error("Please configure at least 20 seats for tests to run properly.");
  }

  // Create the Show
  const showRes = await fetch(`${BASE_URL}/shows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ name: SHOW_NAME, price_paise: 25000, seats: allSeats }),
  });

  if (!showRes.ok) throw new Error(`Failed to create show: ${await showRes.text()}`);
  const show = await showRes.json();
  log(`Created show ID: ${show.id} with ${allSeats.length} seats (${ROWS} rows x ${COLS} cols)`);

  const requests: any[] = [];

  // CASE 1: The Hot Seat Contention
  const hotSeat = allSeats[0];
  for (let i = 0; i < HOT_SEAT_USERS; i++) {
    requests.push({
      token: `user_hot_seat_${i}`,
      payload: { seats: [hotSeat], idempotency_key: crypto.randomUUID() },
      label: 'Hot Seat Race',
    });
  }

  // CASE 2: Quota Bypass Attempt
  const quotaToken = 'greedy_user';
  for (let i = 0; i < QUOTA_REQUESTS; i++) {
    requests.push({
      token: quotaToken,
      payload: { seats: [allSeats[i + 1]], idempotency_key: crypto.randomUUID() },
      label: 'Quota Bypass',
    });
  }

  // CASE 3: Idempotency
  const replayToken = 'flaky_user';
  const replayKey = crypto.randomUUID();
  for (let i = 0; i < 5; i++) {
    requests.push({
      token: replayToken,
      payload: { seats: [allSeats[15]], idempotency_key: replayKey },
      label: 'Idempotency Cache',
    });
  }

  // CASE 4: Idempotency Payload
  const swapToken = 'hacker_user';
  const swapKey = crypto.randomUUID();
  requests.push({
    token: swapToken,
    payload: { seats: [allSeats[16]], idempotency_key: swapKey },
    label: 'Idempotency Swap (Req A)',
  });
  requests.push({
    token: swapToken,
    payload: { seats: [allSeats[17]], idempotency_key: swapKey },
    label: 'Idempotency Swap (Req B)',
  });

  // CASE 5: All or Nothing Multi-Seat Rollback
  requests.push({
    token: 'group_user',
    payload: { seats: [allSeats[18], hotSeat], idempotency_key: crypto.randomUUID() },
    label: 'Multi-Seat Rollback',
  });

  // CASE 6: Non-Existent Seats
  requests.push({
    token: 'confused_user',
    payload: { seats: ['NON_EXISTENT_A', 'NON_EXISTENT_B'], idempotency_key: crypto.randomUUID() },
    label: 'Non-Existent Seat',
  });

  // CASE 7: Random General Load
  for (let i = 0; i < RANDOM_USERS; i++) {
    const randomSeatCount = Math.floor(Math.random() * 3) + 1;
    const chosenSeats = new Set<string>();
    while (chosenSeats.size < randomSeatCount) {
      const randIndex = Math.floor(Math.random() * (allSeats.length - 20)) + 20;
      chosenSeats.add(allSeats[randIndex]);
    }

    requests.push({
      token: `random_user_${i}`,
      payload: { seats: Array.from(chosenSeats).sort(), idempotency_key: crypto.randomUUID() },
      label: 'Random Load',
    });
  }

  requests.sort(() => Math.random() - 0.5);

  log(`Firing ${requests.length} concurrent requests in batches of ${BATCH_SIZE}...`);

  const startTime = Date.now();
  const results: any[] = [];
  const batches = chunkArray(requests, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchResults = await Promise.allSettled(
      batch.map((req) =>
        fetch(`${BASE_URL}/shows/${show.id}/reserve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.token}` },
          body: JSON.stringify(req.payload),
        }).then(async (res) => {
          const isCached = res.headers.get('X-Idempotency-Cache') === 'HIT';
          return {
            status: res.status,
            label: req.label,
            isCached,
            body: await res.json(),
          }
        })
      )
    );
    results.push(...batchResults);
    process.stdout.write(`\rProcessed batch ${i + 1}/${batches.length}...`);
  }
  
  console.log();
  const duration = Date.now() - startTime;
  const rps = Math.round(requests.length / (duration / 1000));
  log(`Concurrent stress phase completed in ${duration}ms (${rps} req/sec)`);

  // CASE 8: Cancellation & Re-booking Flow
  log('Testing Reservation Cancellation & Re-booking...');
  const cancelStartTime = Date.now();
  const cancelSeat = allSeats[19];
  const cancelUserToken = 'cancelling_user';
  const rebookUserToken = 'rebooking_user';
  let cancellationPassed = false;

  try {
    const bookRes = await fetch(`${BASE_URL}/shows/${show.id}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cancelUserToken}` },
      body: JSON.stringify({ seats: [cancelSeat], idempotency_key: crypto.randomUUID() }),
    });
    const bookData = (await bookRes.json()) as any;

    if (bookRes.status === 201 && bookData?.reservation_id) {
      const cancelRes = await fetch(`${BASE_URL}/reservations/${bookData.reservation_id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cancelUserToken}` },
      });

      if (cancelRes.status === 200) {
        const rebookRes = await fetch(`${BASE_URL}/shows/${show.id}/reserve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rebookUserToken}` },
          body: JSON.stringify({ seats: [cancelSeat], idempotency_key: crypto.randomUUID() }),
        });

        if (rebookRes.status === 201) {
          cancellationPassed = true;
        }
      }
    }
  } catch {
    cancellationPassed = false;
  }
  const cancelDuration = Date.now() - cancelStartTime;
  log(`Cancellation test completed in ${cancelDuration}ms (${cancellationPassed ? 'SUCCESS' : 'FAILED'})`);

  const stats = {
    '201 (New Reservation)': 0,
    '201 (Cached Replay)': 0,
    '400 (Bad Request / Missing Seat)': 0,
    '409 (Seat Taken)': 0,
    '409 (Limit Exceeded)': 0,
    '409 (Idempotency Mismatch)': 0,
    '5xx (Server Error)': 0,
    'Other': 0,
  };

  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      const res = result.value;
      if (res.status === 201 && res.isCached) stats['201 (Cached Replay)']++;
      else if (res.status === 201) stats['201 (New Reservation)']++;
      else if (res.status === 400) stats['400 (Bad Request / Missing Seat)']++;
      else if (res.status === 409 && res.body?.reason === 'SEAT_ALREADY_TAKEN') stats['409 (Seat Taken)']++;
      else if (res.status === 409 && res.body?.reason === 'USER_LIMIT_EXCEEDED') stats['409 (Limit Exceeded)']++;
      else if (res.status === 409 && res.body?.reason === 'IDEMPOTENCY_MISMATCH') stats['409 (Idempotency Mismatch)']++;
      else if (res.status >= 500) stats['5xx (Server Error)']++;
      else stats['Other']++;
    } else {
      stats['Other']++;
    }
  });

  console.log('\n--- Status Code Distribution ---');
  console.table(stats);

  const stateRes = await fetch(`${BASE_URL}/shows/${show.id}`);
  const state = (await stateRes.json()) as any;

  console.log('\n--- Final Reconciliation State ---');
  console.table(state.reconciliation);

  // Evaluate Per-Case Invariants
  const fulfilled = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map((r) => r.value);

  const hotSeatResults = fulfilled.filter((r) => r.label === 'Hot Seat Race');
  const hotSeatWins = hotSeatResults.filter((r) => r.status === 201).length;
  const hotSeatDeclined = hotSeatResults.filter((r) => r.status === 409).length;
  const hotSeatPassed = hotSeatWins === 1 && hotSeatWins + hotSeatDeclined === hotSeatResults.length;

  const quotaResults = fulfilled.filter((r) => r.label === 'Quota Bypass');
  const quotaWins = quotaResults.filter((r) => r.status === 201).length;
  const quotaPassed = quotaWins <= 4;

  const replayResults = fulfilled.filter((r) => r.label === 'Idempotency Cache');
  const replayOriginals = replayResults.filter((r) => r.status === 201 && !r.isCached).length;
  const replayHits = replayResults.filter((r) => r.status === 201 && r.isCached).length;
  const replayPassed = replayOriginals === 1 && replayHits === 4;

  const swapResults = fulfilled.filter((r) => r.label?.startsWith('Idempotency Swap'));
  const swapPassed =
    swapResults.some((r) => r.status === 201) &&
    swapResults.some((r) => r.status === 409 && r.body?.reason === 'IDEMPOTENCY_MISMATCH');

  const rollbackResults = fulfilled.filter((r) => r.label === 'Multi-Seat Rollback');
  const rollbackPassed = rollbackResults.every((r) => r.status === 409);

  const nonExistentResults = fulfilled.filter((r) => r.label === 'Non-Existent Seat');
  const nonExistentPassed = nonExistentResults.every((r) => r.status === 400);

  console.log('\n--- Test Case Verdicts ---');
  console.log(`Hot Seat Contention:        ${hotSeatPassed ? '✓ PASSED' : '✗ FAILED'} (${hotSeatWins} winner, ${hotSeatDeclined} declined)`);
  console.log(`Per-User Quota Limit:       ${quotaPassed ? '✓ PASSED' : '✗ FAILED'} (${quotaWins} confirmed <= limit 4)`);
  console.log(`Idempotent Cache Replay:    ${replayPassed ? '✓ PASSED' : '✗ FAILED'} (${replayOriginals} original, ${replayHits} cached hits)`);
  console.log(`Idempotency Payload Swap:   ${swapPassed ? '✓ PASSED' : '✗ FAILED'} (payload mismatch rejected with 409)`);
  console.log(`All-or-Nothing Rollback:    ${rollbackPassed ? '✓ PASSED' : '✗ FAILED'} (partial availability atomic rollback)`);
  console.log(`Non-Existent Seat Check:    ${nonExistentPassed ? '✓ PASSED' : '✗ FAILED'} (rejected with 400 Bad Request)`);
  console.log(`Cancellation & Re-booking:  ${cancellationPassed ? '✓ PASSED' : '✗ FAILED'} (seat freed and booked by new user)`);

  const allPassed =
    hotSeatPassed &&
    quotaPassed &&
    replayPassed &&
    swapPassed &&
    rollbackPassed &&
    nonExistentPassed &&
    cancellationPassed &&
    state.reconciliation?.is_valid === true &&
    stats['5xx (Server Error)'] === 0;

  console.log('--------------------------');
  if (allPassed) {
    log('✓ ALL STRESS TESTS PASSED: All invariants hold, zero 500 errors.');
  } else {
    log('✗ STRESS TESTS FAILED: Invariant violation or errors detected.');
    process.exit(1);
  }
}

runStressTest().catch((err) => {
  console.error(err);
  process.exit(1);
});