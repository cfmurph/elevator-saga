/**
 * Elevator Saga - Optimized Multi-Elevator Controller
 *
 * Strategy: Collective SCAN (C-SCAN variant) with load balancing.
 *
 * Architecture note on error safety:
 *   - Elevator event handlers (idle, passing_floor, stopped_at_floor,
 *     floor_button_pressed) are wrapped by the game's tryTrigger() helper,
 *     so exceptions there are caught by the game engine.
 *   - Floor event handlers (up_button_pressed, down_button_pressed) are NOT
 *     wrapped — any uncaught exception propagates to world.update() and
 *     surfaces as an error in the game's updater loop. Therefore, floor
 *     handlers must use only the safe public API (goToFloor) and must not
 *     throw under any circumstances.
 */

{
    init: function(elevators, floors) {

        // ----- Global state -----
        // pending[floorNum] = { up: bool, down: bool }
        var pending = {};
        floors.forEach(function(f) {
            pending[f.floorNum()] = { up: false, down: false };
        });

        var maxFloor = floors.length - 1;

        // ----- Helpers -----

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

        // Returns all floors this elevator needs to visit regardless of direction.
        function allFloorsNeeded(elevator) {
            var pressed = elevator.getPressedFloors();
            var calls = [];
            floors.forEach(function(floor) {
                var fn = floor.floorNum();
                var p = pending[fn];
                if (p && (p.up || p.down)) calls.push(fn);
            });
            return pressed.concat(calls).filter(function(v, i, a) { return a.indexOf(v) === i; });
        }

        // Pick the "best" elevator for a new floor call at floorNum going in direction dir.
        // Prefer elevators already moving toward that floor and not full.
        // Returns null if no suitable elevator found.
        function bestElevator(floorNum, dir) {
            var best = null;
            var bestScore = Infinity;

            elevators.forEach(function(el) {
                if (el.loadFactor() >= 1.0) return; // full

                var cur = el.currentFloor();
                var elDir = el.destinationDirection();
                var dist = Math.abs(cur - floorNum);
                var score;

                if ((elDir === "up" && dir === "up" && cur <= floorNum) ||
                    (elDir === "down" && dir === "down" && cur >= floorNum)) {
                    score = dist;
                } else if (elDir === "stopped") {
                    score = dist + 5;
                } else {
                    score = dist + (maxFloor * 2);
                }

                if (score < bestScore) {
                    bestScore = score;
                    best = el;
                }
            });

            return best;
        }

        // Central "what should this elevator do next?" logic, called when idle.
        // Runs inside the game's tryTrigger() safety wrapper — safe to do
        // direct destinationQueue manipulation here.
        function scheduleIdle(elevator) {
            var cur = elevator.currentFloor();
            var needed = allFloorsNeeded(elevator);

            if (needed.length === 0) {
                setIndicators(elevator, "both");
                if (cur !== 0) elevator.goToFloor(0);
                return;
            }

            // Find nearest needed floor to decide sweep direction.
            var nearest = needed.reduce(function(prev, f) {
                return Math.abs(f - cur) < Math.abs(prev - cur) ? f : prev;
            });

            var dir = nearest >= cur ? "up" : "down";
            setIndicators(elevator, dir);

            // Build sorted queue: serve floors ahead first, then reverse for the rest.
            var ahead = needed.filter(function(f) {
                return dir === "up" ? f >= cur : f <= cur;
            });
            var behind = needed.filter(function(f) {
                return dir === "up" ? f < cur : f > cur;
            });

            if (dir === "up") {
                ahead.sort(function(a, b) { return a - b; });
                behind.sort(function(a, b) { return b - a; });
            } else {
                ahead.sort(function(a, b) { return b - a; });
                behind.sort(function(a, b) { return a - b; });
            }

            var newQueue = ahead.concat(behind);
            elevator.destinationQueue = newQueue;
            elevator.checkDestinationQueue();
        }

        // ----- Wire up each elevator -----
        elevators.forEach(function(elevator) {

            setIndicators(elevator, "both");

            elevator.on("idle", function() {
                scheduleIdle(elevator);
            });

            // Passenger inside pressed a floor button.
            elevator.on("floor_button_pressed", function(floorNum) {
                // Add to queue respecting current sweep direction.
                var cur = elevator.currentFloor();
                var dir = elevator.destinationDirection();
                var queue = elevator.destinationQueue;
                if (queue.indexOf(floorNum) === -1) {
                    queue.push(floorNum);
                    if (dir === "up" || (dir === "stopped" && floorNum >= cur)) {
                        queue.sort(function(a, b) { return a - b; });
                    } else {
                        queue.sort(function(a, b) { return b - a; });
                    }
                    elevator.destinationQueue = queue;
                    elevator.checkDestinationQueue();
                }
            });

            // About to pass a floor: decide whether to stop.
            elevator.on("passing_floor", function(floorNum, direction) {
                var p = pending[floorNum] || { up: false, down: false };
                var pressed = elevator.getPressedFloors();
                var wantThisFloor = pressed.indexOf(floorNum) !== -1;
                var waitingInDir = (direction === "up" && p.up) || (direction === "down" && p.down);
                var canTakeMore = elevator.loadFactor() < 0.85;

                if (wantThisFloor || (waitingInDir && canTakeMore)) {
                    elevator.goToFloor(floorNum, true);
                }
            });

            // Stopped at a floor: clear pending flags and update direction indicators.
            elevator.on("stopped_at_floor", function(floorNum) {
                var p = pending[floorNum];
                if (p) {
                    if (elevator.goingUpIndicator()) p.up = false;
                    if (elevator.goingDownIndicator()) p.down = false;
                }

                var queue = elevator.destinationQueue;
                var nextUp = queue.some(function(f) { return f > floorNum; });
                var nextDown = queue.some(function(f) { return f < floorNum; });
                var pressed = elevator.getPressedFloors();
                var pressedAbove = pressed.some(function(f) { return f > floorNum; });
                var pressedBelow = pressed.some(function(f) { return f < floorNum; });
                var callAbove = floors.some(function(fl) {
                    var fn = fl.floorNum();
                    var fp = pending[fn];
                    return fn > floorNum && fp && (fp.up || fp.down);
                });
                var callBelow = floors.some(function(fl) {
                    var fn = fl.floorNum();
                    var fp = pending[fn];
                    return fn < floorNum && fp && (fp.up || fp.down);
                });

                var goingUp = nextUp || (!nextDown && (pressedAbove || callAbove));
                var goingDown = nextDown || (!nextUp && (pressedBelow || callBelow));

                if (!goingUp && !goingDown) {
                    setIndicators(elevator, "both");
                } else {
                    elevator.goingUpIndicator(goingUp);
                    elevator.goingDownIndicator(goingDown);
                }
            });
        });

        // ----- Wire up each floor -----
        // IMPORTANT: floor event handlers are NOT wrapped by the game's error
        // handler. Only use the safe public goToFloor() API here — no direct
        // destinationQueue manipulation.
        floors.forEach(function(floor) {
            var fn = floor.floorNum();

            floor.on("up_button_pressed", function() {
                pending[fn].up = true;
                var el = bestElevator(fn, "up");
                if (el) el.goToFloor(fn);
            });

            floor.on("down_button_pressed", function() {
                pending[fn].down = true;
                var el = bestElevator(fn, "down");
                if (el) el.goToFloor(fn);
            });
        });
    },

    update: function(dt, elevators, floors) {
        // Periodic health-check: rescue any interior button presses that the
        // event system might have missed (e.g. after a queue reset).
        elevators.forEach(function(elevator) {
            if (elevator.destinationQueue.length === 0) {
                var pressed = elevator.getPressedFloors();
                pressed.forEach(function(f) { elevator.goToFloor(f); });
            }
        });
    }
}
