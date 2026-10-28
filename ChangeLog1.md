## Day 1:
 ## Plan: Create an interactive water body with fishes and possibely multiple other creatures, that interact with the user's hand through camera tracking.

 ## Implementation:
 *Initial set up: created a top down view of a pond using HTML and JavaScript rendering for the water ripple effect, using a screen grid.
 *added simple koi fish that wander around aimlessly and interact with the cursor(swim away when cursor moved swiftly and interact when cursor still for a while)
 *added few details to ponds like stones, lily pads, options to drop food to the koi, drop some petals into the pond, provide option to change the atmosphere theme and some light effects on the floor.

 ## changes:
 *improved the water effects like ripples by changing the implementation from Screen grid to WebGL wave calculations.
 *improved fish movements to seem more natural by making the fish multi jointed to let them bend as they move.
 *split the code into multiple files to keep the code base modular and re-usable. Split the code file into separate input handling files and simulation files.
 *used Living World project's camera input code file to integrate into this implementation, to help with taking input from camera using hand tracking and gesture detection like pinching to click. kept the code files modular.
 *updated the camera module to fix some bugs and increase number of hands detected
 *fixed hand input bug
 *added frog animation into the simulation to move around and jump onto the Lily pads. Kept the frogs as NPCs for now to help with debugging.
 *fixed bug with Lily pads being placed on top of one another sometimes randomly.
 *changed resize behaviour from generating lily pads and pond floor pebbles each time the window is resized, to stay constant even after resizing.

## Day 2:
 ## Plan: test the environment thoroughly for bugs and fix if any found. Research unique implementations of new tech.

 ## Implementation:
 *Commented out uneccessary underwater graphics, except the fish.
 *Found a bug which the fish's fleeing state when the disturbance changes direction repeatedly. Fixed fleeing fish behavior so they turn away from a moving pursuer without restarting their flee timer.

 ## Changes:
 *the food pellet logic was commented out, brought that back to functionality.
 *fixed a camera hand-detection bug caused by an undefined normalized-landmarks variable, which made the tracker clear detected hands when processing them.
 *passed mirrored hand landmarks through the camera input and into the underwater renderer, and retained them during brief tracking dropouts.
 *added hand-shadow rendering on the pond floor using detected landmarks, with a fallback silhouette when landmarks are unavailable.
 