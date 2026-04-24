/**
 * Elevator Saga - Optimized Multi-Elevator Controller
 *
 * Safety rules enforced throughout:
 *
 *  1. Floor event handlers (up_button_pressed, down_button_pressed) are NOT
 *     wrapped by the game's tryTrigger() safety net. They must NEVER cause
 *     elevator.checkDestinationQueue() or the real elevator.goToFloor() to be
 *     called, because the elevator may be in its 1-second arrival wait
 *     (isBusy() == true) and the real goToFloor() throws when called on a
 *     busy elevator via makeSureNotBusy(). The interface's goToFloor() gates
 *     on isBusy() inside checkDestinationQueue — but only one level deep.
 *     To be safe, floor handlers only mutate the pending[] map and push
 *     directly onto the destination queue without triggering checkDQ.
 *
 *  2. Elevator event handlers (idle, floor_button_pressed, passing_floor,
 *     stopped_at_floor) ARE wrapped by tryTrigger(), so they may safely use
 *     the full interface API including goToFloor() and checkDestinationQueue().
 *
 *  3. The update() callback is wrapped in a try/catch by the game engine,
 *     so it is also safe.
 */

{
    init: function(elevators, floors) {

        // pending[floorNum] = { up: bool, down: bool }
        var pending = {};
        floors.forEach(function(f) {
            pending[f.floorNum()] = { up: false, down: false };
        });

        var numFloors = floors.length;

        // ------------------------------------------------------------------ //
        // Helpers
        // ------------------------------------------------------------------ //

        function setIndicators(elevator, dir) {
            if (dir === "up") {
                elevator.goingUpIndicator(true);
                elevator.goingDownIndicator(false);
            } else if (dir === "down") {
                elevator.goingUpIndicator(false);
                elevator.goingDownIndicator(true);
            } else {
                elevator.goingUpIndicator(true);
                elevator.goingDownIndicator(true);
            }
        }

        // All floor numbers this elevator should eventually visit.
        function allNeeded(elevator) {
            var pressed = elevator.getPressedFloors();
            var calls = [];
            for (var i = 0; i < numFloors; i++) {
                var p = pending[i];
                if (p && (p.up || p.down)) calls.push(i);
            }
            // Deduplicate
            var combined = pressed.concat(calls);
            var seen = {};
            var result = [];
            for (var j = 0; j < combined.length; j++) {
                if (!seen[combined[j]]) {
                    seen[combined[j]] = true;
                    result.push(combined[j]);
                }
            }
            return result;
        }

        // Score for assigning a new call at floorNum (in direction dir) to an elevator.
        // Lower is better. Returns Infinity if the elevator should not be considered.
        function score(elevator, floorNum, dir) {
            if (elevator.loadFactor() >= 1.0) return Infinity;
            var cur = elevator.currentFloor();
            var elDir = elevator.destinationDirection();
            var dist = Math.abs(cur - floorNum);
            if ((elDir === "up"   && dir === "up"   && cur <= floorNum) ||
                (elDir === "down" && dir === "down" && cur >= floorNum)) {
                return dist;                        // already heading the right way
            }
            if (elDir === "stopped") return dist + 3;
            return dist + numFloors * 2;            // going the wrong way
        }

        function bestElevator(floorNum, dir) {
            var best = null, bestScore = Infinity;
            for (var i = 0; i < elevators.length; i++) {
                var s = score(elevators[i], floorNum, dir);
                if (s < bestScore) { bestScore = s; best = elevators[i]; }
            }
            return best;
        }

        // Build a SCAN-ordered visit list starting from cur going in dir.
        function buildQueue(needed, cur, dir) {
            var ahead = [], behind = [];
            for (var i = 0; i < needed.length; i++) {
                var f = needed[i];
                if (dir === "up")   { if (f >= cur) ahead.push(f); else behind.push(f); }
                else                { if (f <= cur) ahead.push(f); else behind.push(f); }
            }
            if (dir === "up") {
                ahead.sort(function(a, b)  { return a - b; });
                behind.sort(function(a, b) { return b - a; });
            } else {
                ahead.sort(function(a, b)  { return b - a; });
                behind.sort(function(a, b) { return a - b; });
            }
            return ahead.concat(behind);
        }

        // ------------------------------------------------------------------ //
        // Elevator setup
        // ------------------------------------------------------------------ //

        elevators.forEach(function(elevator) {
            setIndicators(elevator, "both");

            // Idle: plan the next sweep using the public goToFloor API only.
            // (Runs inside tryTrigger — safe to call goToFloor freely.)
            elevator.on("idle", function() {
                var cur  = elevator.currentFloor();
                var needed = allNeeded(elevator);

                if (needed.length === 0) {
                    setIndicators(elevator, "both");
                    if (cur !== 0) elevator.goToFloor(0);
                    return;
                }

                // Choose direction toward the nearest needed floor.
                var nearest = needed[0];
                for (var i = 1; i < needed.length; i++) {
                    if (Math.abs(needed[i] - cur) < Math.abs(nearest - cur)) nearest = needed[i];
                }
                var dir = (nearest >= cur) ? "up" : "down";
                setIndicators(elevator, dir);

                // Enqueue floors in SCAN order via the public API.
                // goToFloor() appends and calls checkDestinationQueue internally.
                var ordered = buildQueue(needed, cur, dir);
                for (var j = 0; j < ordered.length; j++) {
                    elevator.goToFloor(ordered[j]);
                }
            });

            // Passenger inside the elevator pressed a button.
            // (Runs inside tryTrigger — safe.)
            elevator.on("floor_button_pressed", function(floorNum) {
                elevator.goToFloor(floorNum);
            });

            // About to pass a floor — decide whether to stop.
            // (Runs inside tryTrigger — safe.)
            elevator.on("passing_floor", function(floorNum, direction) {
                var p = pending[floorNum] || { up: false, down: false };
                var pressed = elevator.getPressedFloors();
                var wantThisFloor = false;
                for (var i = 0; i < pressed.length; i++) {
                    if (pressed[i] === floorNum) { wantThisFloor = true; break; }
                }
                var callInDir = (direction === "up" && p.up) || (direction === "down" && p.down);
                if (wantThisFloor || (callInDir && elevator.loadFactor() < 0.85)) {
                    elevator.goToFloor(floorNum, true);
                }
            });

            // Arrived at a floor — update indicators and clear pending flags.
            // (Runs inside tryTrigger — safe.)
            elevator.on("stopped_at_floor", function(floorNum) {
                var p = pending[floorNum];
                if (p) {
                    if (elevator.goingUpIndicator())   p.up   = false;
                    if (elevator.goingDownIndicator()) p.down = false;
                }

                var queue = elevator.destinationQueue;
                var hasUp   = false, hasDown = false;
                for (var i = 0; i < queue.length; i++) {
                    if (queue[i] > floorNum) hasUp   = true;
                    if (queue[i] < floorNum) hasDown = true;
                }

                if      (hasUp && !hasDown) setIndicators(elevator, "up");
                else if (hasDown && !hasUp) setIndicators(elevator, "down");
                else if (!hasUp && !hasDown) setIndicators(elevator, "both");
                // else both directions still queued — leave indicators as-is
            });
        });

        // ------------------------------------------------------------------ //
        // Floor button handlers
        //
        // CRITICAL: These are NOT wrapped by the game's tryTrigger(). Any
        // exception here propagates directly to world.update() and surfaces as
        // the updater@world.js crash.
        //
        // Rules:
        //  - Only mutate the pending[] map and the elevator's destinationQueue
        //    array directly (safe property writes, no method calls that could
        //    call makeSureNotBusy() on a busy elevator).
        //  - Do NOT call elevator.checkDestinationQueue() — that would invoke
        //    the real elevator.goToFloor() which throws if the elevator is
        //    currently busy (e.g. in its 1-second arrival wait).
        // ------------------------------------------------------------------ //

        floors.forEach(function(floor) {
            var fn = floor.floorNum();

            floor.on("up_button_pressed", function() {
                pending[fn].up = true;
                var el = bestElevator(fn, "up");
                if (el) {
                    // Append to the interface queue without triggering checkDQ.
                    var q = el.destinationQueue;
                    var already = false;
                    for (var i = 0; i < q.length; i++) { if (q[i] === fn) { already = true; break; } }
                    if (!already) { q.push(fn); }
                }
            });

            floor.on("down_button_pressed", function() {
                pending[fn].down = true;
                var el = bestElevator(fn, "down");
                if (el) {
                    var q = el.destinationQueue;
                    var already = false;
                    for (var i = 0; i < q.length; i++) { if (q[i] === fn) { already = true; break; } }
                    if (!already) { q.push(fn); }
                }
            });
        });
    },

    // update() is wrapped in try/catch by the game — safe to use full API.
    // Use it to flush any queue entries that were added by floor handlers
    // (which append to destinationQueue but intentionally skip checkDQ).
    update: function(dt, elevators, floors) {
        for (var i = 0; i < elevators.length; i++) {
            var elevator = elevators[i];
            // checkDestinationQueue processes any pending queue entries only
            // when the elevator is not busy — it is a no-op when busy.
            if (elevator.destinationQueue.length > 0) {
                elevator.checkDestinationQueue();
            }
        }
    }
}
