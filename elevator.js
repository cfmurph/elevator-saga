{
    init: function(elevators, floors) {

        // pending[floorNum] = { up: bool, down: bool }
        // Tracks unserved floor button presses so idle elevators can pick them up.
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
            var seen = {}, result = [], i, fn;
            for (i = 0; i < pressed.length; i++) {
                if (!seen[pressed[i]]) { seen[pressed[i]] = true; result.push(pressed[i]); }
            }
            for (i = 0; i < numFloors; i++) {
                fn = i;
                if (!seen[fn] && pending[fn] && (pending[fn].up || pending[fn].down)) {
                    seen[fn] = true;
                    result.push(fn);
                }
            }
            return result;
        }

        // Score for assigning a call at floorNum (in direction dir) to an elevator.
        function scoreElevator(elevator, floorNum, dir) {
            if (elevator.loadFactor() >= 1.0) return Infinity;
            var cur = elevator.currentFloor();
            var elDir = elevator.destinationDirection();
            var dist = Math.abs(cur - floorNum);
            if ((elDir === "up"   && dir === "up"   && cur <= floorNum) ||
                (elDir === "down" && dir === "down" && cur >= floorNum)) {
                return dist;
            }
            if (elDir === "stopped") return dist + 3;
            return dist + numFloors * 2;
        }

        function bestElevator(floorNum, dir) {
            var best = null, bestScore = Infinity, i, s;
            for (i = 0; i < elevators.length; i++) {
                s = scoreElevator(elevators[i], floorNum, dir);
                if (s < bestScore) { bestScore = s; best = elevators[i]; }
            }
            return best;
        }

        // ------------------------------------------------------------------ //
        // Elevator setup
        //
        // All event handlers are wrapped by the game's tryTrigger() and are
        // safe to use the full elevator interface API, including goToFloor().
        // ------------------------------------------------------------------ //

        elevators.forEach(function(elevator) {
            setIndicators(elevator, "both");

            // Idle: send the elevator on a SCAN sweep of all pending floors.
            elevator.on("idle", function() {
                var cur = elevator.currentFloor();
                var needed = allNeeded(elevator);
                var i, f;

                if (needed.length === 0) {
                    setIndicators(elevator, "both");
                    if (cur !== 0) elevator.goToFloor(0);
                    return;
                }

                // Sweep toward nearest needed floor; handle the far side after.
                var nearest = needed[0];
                for (i = 1; i < needed.length; i++) {
                    if (Math.abs(needed[i] - cur) < Math.abs(nearest - cur)) nearest = needed[i];
                }
                var dir = (nearest >= cur) ? "up" : "down";
                setIndicators(elevator, dir);

                // Split into ahead/behind and sort for SCAN order.
                var ahead = [], behind = [];
                for (i = 0; i < needed.length; i++) {
                    f = needed[i];
                    if (dir === "up")  { if (f >= cur) ahead.push(f); else behind.push(f); }
                    else               { if (f <= cur) ahead.push(f); else behind.push(f); }
                }
                if (dir === "up") {
                    ahead.sort(function(a, b)  { return a - b; });
                    behind.sort(function(a, b) { return b - a; });
                } else {
                    ahead.sort(function(a, b)  { return b - a; });
                    behind.sort(function(a, b) { return a - b; });
                }
                var ordered = ahead.concat(behind);
                for (i = 0; i < ordered.length; i++) {
                    elevator.goToFloor(ordered[i]);
                }
            });

            // Passenger inside the elevator pressed a button — go there.
            elevator.on("floor_button_pressed", function(floorNum) {
                elevator.goToFloor(floorNum);
            });

            // About to pass a floor — decide whether to stop.
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

            // Arrived at a floor — clear pending flags, update indicators.
            elevator.on("stopped_at_floor", function(floorNum) {
                var p = pending[floorNum];
                if (p) {
                    if (elevator.goingUpIndicator())   p.up   = false;
                    if (elevator.goingDownIndicator()) p.down = false;
                }

                var queue = elevator.destinationQueue;
                var hasUp = false, hasDown = false;
                for (var i = 0; i < queue.length; i++) {
                    if (queue[i] > floorNum) hasUp   = true;
                    if (queue[i] < floorNum) hasDown = true;
                }
                if      (hasUp && !hasDown) setIndicators(elevator, "up");
                else if (hasDown && !hasUp) setIndicators(elevator, "down");
                else if (!hasUp && !hasDown) setIndicators(elevator, "both");
            });
        });

        // ------------------------------------------------------------------ //
        // Floor button handlers
        //
        // These fire via the floor's own tryTrigger() so exceptions are caught.
        // Use only the public goToFloor() API — never checkDestinationQueue().
        // ------------------------------------------------------------------ //

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

    // Keep update() empty — any logic here runs outside tryTrigger() and a
    // throw propagates directly to the game's updater at world.js:248.
    update: function(dt, elevators, floors) {}
}
