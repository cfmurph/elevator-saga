# elevator-saga

Paste-ready controllers for [Elevator Saga](https://play.elevatorsaga.com/).

## Controllers

| File | Strategy |
|---|---|
| `elevator.js` | Request-queue + SCAN with passing pickups (default) |
| `elevator-cscan.js` | Collective SCAN (C-SCAN) with load balancing |

### `elevator.js` — request-queue + SCAN

All floor button presses go into a FIFO request queue. Elevators react to button presses rather than polling via `idle`. When an elevator finishes its queue it picks the nearer of the two oldest pending requests.

- **In-transit pickups:** stop for same-direction waiters when there is capacity
- **SCAN-ordered queue:** destinations are re-sorted into an up sweep then a down sweep
- **Fair to current passengers:** direction reverses only after onboard passengers are dropped off
- **Periodic cleanup:** `update` prunes stale destinations after another elevator “steals” a waiting group

Bugfixes included:

1. `hasRequest()` compares floor + direction element-wise (reference `indexOf` never matched)
2. `floor.my_onButton(direction)` takes only the direction; the floor number comes from `floor.floorNum()`

### `elevator-cscan.js` — C-SCAN + load balancing

The controller previously on `main` from [#1](https://github.com/cfmurph/elevator-saga/pull/1):

- Global pending up/down map
- Directional sweep with passing-floor pickups
- Best-elevator dispatch (heading the right way wins; idle is slightly penalized; full cars are skipped)
- Load cap of 0.85 on passing stops
- Idle parking at floor 0

## Usage

1. Open [https://play.elevatorsaga.com/](https://play.elevatorsaga.com/)
2. Paste the full contents of `elevator.js` (or `elevator-cscan.js`) into the code editor
3. Click **Apply**
