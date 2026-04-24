/**
 * Elevator Saga - Optimized Multi-Elevator Controller
 *
 * Strategy: Collective SCAN (C-SCAN variant) with load balancing.
 *
 * Key ideas:
 *  1. Track all pending floor requests (up/down) globally.
 *  2. Assign the best idle elevator to serve a new floor request.
 *  3. Each elevator runs a directional sweep (like a disk head), picking
 *     up passengers along the way (via passing_floor), and only reverses
 *     direction when there is nothing further ahead.
 *  4. When idle, an elevator checks for any unserved floor calls and heads
 *     toward the nearest one in the most useful direction.
 *  5. goingUp/goingDown indicators are kept consistent so passengers board
 *     the correct elevator.
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

        // Returns all floor numbers (from floor buttons OR pending calls) that
        // this elevator should eventually serve given its current direction.
        function floorsAhead(elevator, dir) {
            var cur = elevator.currentFloor();
            var pressed = elevator.getPressedFloors();
            var result = [];

            pressed.forEach(function(f) {
                if (dir === "up" && f > cur) result.push(f);
                if (dir === "down" && f < cur) result.push(f);
            });

            floors.forEach(function(floor) {
                var fn = floor.floorNum();
                if (dir === "up" && fn > cur && (pending[fn].up || pending[fn].down)) result.push(fn);
                if (dir === "down" && fn < cur && (pending[fn].up || pending[fn].down)) result.push(fn);
            });

            // Deduplicate
            result = result.filter(function(v, i, a) { return a.indexOf(v) === i; });
            return result;
        }

        // Returns all floors this elevator needs to visit regardless of direction.
        function allFloorsNeeded(elevator) {
            var pressed = elevator.getPressedFloors();
            var calls = [];
            floors.forEach(function(floor) {
                var fn = floor.floorNum();
                if (pending[fn].up || pending[fn].down) calls.push(fn);
            });
            return pressed.concat(calls).filter(function(v, i, a) { return a.indexOf(v) === i; });
        }

        // Pick the "best" elevator for a new floor call at floorNum going in direction dir.
        // Prefer elevators already moving toward that floor and not full.
        function bestElevator(floorNum, dir) {
            var best = null;
            var bestScore = Infinity;

            elevators.forEach(function(el) {
                if (el.loadFactor() >= 1.0) return; // full

                var cur = el.currentFloor();
                var elDir = el.destinationDirection();
                var dist = Math.abs(cur - floorNum);
                var score;

                // An elevator already heading the right way toward the floor is ideal
                if ((elDir === "up" && dir === "up" && cur <= floorNum) ||
                    (elDir === "down" && dir === "down" && cur >= floorNum)) {
                    score = dist; // best case
                } else if (elDir === "stopped") {
                    score = dist + 5; // idle but available
                } else {
                    score = dist + (maxFloor * 2); // going the wrong way, penalise
                }

                if (score < bestScore) {
                    bestScore = score;
                    best = el;
                }
            });

            return best;
        }

        // Dispatch an elevator to a floor, respecting its current sweep direction.
        function dispatchToFloor(elevator, floorNum) {
            var queue = elevator.destinationQueue;
            if (queue.indexOf(floorNum) === -1) {
                queue.push(floorNum);
                // Sort according to current direction: up → ascending, down → descending.
                var dir = elevator.destinationDirection();
                var cur = elevator.currentFloor();
                if (dir === "up" || (dir === "stopped" && floorNum >= cur)) {
                    queue.sort(function(a, b) { return a - b; });
                } else {
                    queue.sort(function(a, b) { return b - a; });
                }
                elevator.destinationQueue = queue;
                elevator.checkDestinationQueue();
            }
        }

        // When an elevator stops, clear the pending flag for that floor in the
        // appropriate direction(s), and also serve interior button presses.
        function handleStop(elevator, floorNum) {
            // Clear pending based on current direction indicators
            if (elevator.goingUpIndicator()) pending[floorNum].up = false;
            if (elevator.goingDownIndicator()) pending[floorNum].down = false;
        }

        // Central "what should this elevator do next?" logic, called when idle.
        function scheduleIdle(elevator) {
            var cur = elevator.currentFloor();
            var needed = allFloorsNeeded(elevator);

            if (needed.length === 0) {
                // Park at ground floor if completely idle, to be ready.
                setIndicators(elevator, "both");
                if (cur !== 0) elevator.goToFloor(0);
                return;
            }

            // Find nearest needed floor
            var nearest = needed.reduce(function(prev, f) {
                return Math.abs(f - cur) < Math.abs(prev - cur) ? f : prev;
            });

            var dir = nearest >= cur ? "up" : "down";
            setIndicators(elevator, dir);

            // Build sorted queue: sweep in direction of nearest, handle the rest after.
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

            // Idle: recalculate best route
            elevator.on("idle", function() {
                scheduleIdle(elevator);
            });

            // A passenger inside pressed a floor button → add it to queue in order
            elevator.on("floor_button_pressed", function(floorNum) {
                dispatchToFloor(elevator, floorNum);
            });

            // About to pass a floor: decide whether to stop
            elevator.on("passing_floor", function(floorNum, direction) {
                // Stop if there are passengers waiting in that direction OR who want this floor
                var pressed = elevator.getPressedFloors();
                var wantThisFloor = pressed.indexOf(floorNum) !== -1;
                var waitingUp = pending[floorNum].up && direction === "up";
                var waitingDown = pending[floorNum].down && direction === "down";
                var canTakeMore = elevator.loadFactor() < 0.85;

                if (wantThisFloor || ((waitingUp || waitingDown) && canTakeMore)) {
                    elevator.goToFloor(floorNum, true); // insert at front of queue
                }
            });

            // Stopped: update indicators and clear pending flags
            elevator.on("stopped_at_floor", function(floorNum) {
                handleStop(elevator, floorNum);

                // Determine what's still needed above/below to set indicator
                var pressedAbove = elevator.getPressedFloors().some(function(f) { return f > floorNum; });
                var pressedBelow = elevator.getPressedFloors().some(function(f) { return f < floorNum; });
                var callAbove = floors.some(function(fl) { return fl.floorNum() > floorNum && (pending[fl.floorNum()].up || pending[fl.floorNum()].down); });
                var callBelow = floors.some(function(fl) { return fl.floorNum() < floorNum && (pending[fl.floorNum()].up || pending[fl.floorNum()].down); });
                var queue = elevator.destinationQueue;
                var nextUp = queue.some(function(f) { return f > floorNum; });
                var nextDown = queue.some(function(f) { return f < floorNum; });

                var goingUp = nextUp || (!nextDown && (pressedAbove || callAbove));
                var goingDown = nextDown || (!nextUp && (pressedBelow || callBelow));

                // If uncertain (at top/bottom), allow both
                if (!goingUp && !goingDown) {
                    setIndicators(elevator, "both");
                } else {
                    elevator.goingUpIndicator(goingUp);
                    elevator.goingDownIndicator(goingDown);
                }
            });
        });

        // ----- Wire up each floor -----
        floors.forEach(function(floor) {
            var fn = floor.floorNum();

            floor.on("up_button_pressed", function() {
                pending[fn].up = true;
                var el = bestElevator(fn, "up");
                if (el) dispatchToFloor(el, fn);
            });

            floor.on("down_button_pressed", function() {
                pending[fn].down = true;
                var el = bestElevator(fn, "down");
                if (el) dispatchToFloor(el, fn);
            });
        });
    },

    update: function(dt, elevators, floors) {
        // Most logic is event-driven; update is used for periodic health checks.
        // Detect any stuck elevators (idle with unserved requests) and nudge them.
        elevators.forEach(function(elevator) {
            if (elevator.destinationQueue.length === 0) {
                var pressed = elevator.getPressedFloors();
                if (pressed.length > 0) {
                    // Somehow lost track of a button press; go there now.
                    pressed.forEach(function(f) { elevator.goToFloor(f); });
                }
            }
        });
    }
}
