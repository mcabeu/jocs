// include: shell.js
"use strict";

// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(moduleArg) => Promise<Module>
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Module != 'undefined' ? Module : {};

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).

var ENVIRONMENT_IS_WEB = true;
var ENVIRONMENT_IS_WORKER = false;
var ENVIRONMENT_IS_NODE = false;
var ENVIRONMENT_IS_SHELL = false;
if (Module['ENVIRONMENT']) {
  throw new Error('Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)');
}

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
// include: /tmp/bob.1.0/puzzles/emccpre.js
/*
 * emccpre.js: one of the Javascript components of an Emscripten-based
 * web/Javascript front end for Puzzles.
 *
 * The other parts of this system live in emcc.c and emcclib.js. It
 * also depends on being run in the context of a web page containing
 * an appropriate collection of bits and pieces (a canvas, some
 * buttons and links etc), which is generated for each puzzle by the
 * script html/jspage.pl.
 *
 * This file contains the Javascript code which is prefixed unmodified
 * to Emscripten's output via the --pre-js option. It declares all our
 * global variables, and provides the puzzle init function and a
 * couple of other helper functions.
 */

// Because this script is run using <script defer>, we can guarantee
// that the DOM is complete, so it's OK to look up elements
// immediately.  On the other hand, the Emscripten runtime hasn't
// started yet, so Module.cwrap isn't safe.

// Error handler to make any failures from here on visible to the
// user, maybe.
window.addEventListener("error", function (e) {
  alert(e.message);
});

// To avoid flicker while doing complicated drawing, we use two
// canvases, the same size. One is actually on the web page, and the
// other is off-screen. We do all our drawing on the off-screen one
// first, and then copy rectangles of it to the on-screen canvas in
// response to draw_update() calls by the game backend.
var onscreen_canvas, offscreen_canvas;

// A persistent drawing context for the offscreen canvas, to save
// requesting it for each individual graphics operation.
var ctx;

// Bounding rectangle for the copy to the onscreen canvas that will be
// done at drawing end time. Updated by js_canvas_draw_update and used
// by js_canvas_end_draw.
var update_xmin, update_xmax, update_ymin, update_ymax;

// Colour strings to use when drawing, to save converting them from C
// every time.
var colours = [];

// Module object for Emscripten. We fill in these parameters to ensure
// that when main() returns nothing will get cleaned up so we remain
// able to call the puzzle's various callbacks.
//
// Page loading order:
//
// 1. The browser starts reading *.html (which comes from jspage.pl)
// 2. It finds the <script> tag.  This is marked defer, so the
//    browser will start fetching and parsing it, but not execute it
//    until the page has loaded.
//
// Now the browser is loading *.html and *.js in parallel.  The
// html is rendered as we go, and the js is deferred.
//
// 3. The HTML finishes loading.  The browser is about to fire the
//    `DOMContentLoaded` event (ie `onload`) but before that, it
//    actually runs the deferred JS.  This consists of
//
//    (i) emccpre.js (this file).  This sets up various JS variables
//      including the emscripten Module object, which includes the
//      environment variables and argv seen by main().
//
//    (ii) emscripten's JS.  This starts the WASM loading.
//
// When this JS execution is complete, the browser fires the `onload`
// event.  This is ignored.  It continues loading the WASM.
//
// 4. The WASM loading and initialisation completes.  Emscripten's
//    runtime calls the C `main` to actually start the puzzle.  It
//    then calls initPuzzle, which:
//
//      (a) finds various DOM elements and bind them to variables,
//      which depends on the HTML having loaded (it has).
//
//      (b) makes various `cwrap` calls into the emscripten module to
//      set up hooks; this depends on the emscripten JS having been
//      loaded (it has).

var Module = {
  'preRun': function () {
    // Merge environment variables from HTML script elements.
    // This means you can add something like this to the HTML:
    // <script id="environment" type="application/json">
    //   { "LOOPY_DEFAULT": "20x10t11dh" }
    // </script>
    var envscript, k, v;
    for (envscript of document.querySelectorAll("script#environment, script.environment")) for ([k, v] of Object.entries(JSON.parse(envscript.textContent))) ENV[k] = v;
  },
  // Pass argv[1] as the fragment identifier (so that permalinks of
  // the form puzzle.html#game-id can launch the specified id).
  'arguments': [decodeURIComponent(location.hash)],
  'noExitRuntime': true
};

// Variables used by js_canvas_find_font_midpoint().
var midpoint_test_str = "ABCDEFGHIKLMNOPRSTUVWXYZ0123456789";
var midpoint_cache = [];

// Variables used by js_activate_timer() and js_deactivate_timer().
var timer;
var timer_reference;

// void timer_callback(double tplus);
//
// Called every frame while timing is active.
var timer_callback;

// The status bar object, if we have one.
var statusbar = document.getElementById("statusbar");

// Currently live blitters. We keep an integer id for each one on the
// JS side; the C side, which expects a blitter to look like a struct,
// simply defines the struct to contain that integer id.
var blittercount = 0;
var blitters = new Map();

// State for the dialog-box mechanism. dlg_dimmer and dlg_form are the
// page-darkening overlay and the actual dialog box respectively;
// dlg_return_funcs is a list of JS functions to be called when the OK
// button is pressed, to pass the results back to C.
var dlg_dimmer = null,
  dlg_form = null;
var dlg_return_funcs = null;

// void dlg_return_sval(int index, const char *val);
// void dlg_return_ival(int index, int val);
//
// C-side entry points called by functions in dlg_return_funcs, to
// pass back the final value in each dialog control.
var dlg_return_sval, dlg_return_ival;

// Callback for reading from a savefile.  This will be filled in with
// a suitable closure by the JS loading code and called by
// js_savefile_read().  This assumes that only one file can be in the
// process of loading at a time.
var savefile_read_callback;

// void prefs_load_callback(midend *me, const char *prefs);
//
// Callback for passing in preferences data retrieved from localStorage.
var prefs_load_callback;

// The <ul> object implementing the game-type drop-down, and a list of
// the sub-lists inside it. Used by js_add_preset().
var gametypelist = document.getElementById("gametype");
var gametypesubmenus = [gametypelist];

// C entry point for miscellaneous events.
var command;

// The <form> encapsulating the menus.  Used by
// js_get_selected_preset() and js_select_preset().
var menuform = document.getElementById("gamemenu");

// The two anchors used to give permalinks to the current puzzle. Used
// by js_update_permalinks().
var permalink_seed = document.getElementById("permalink-seed");
var permalink_desc = document.getElementById("permalink-desc");

// The various buttons. Undo and redo are used by js_enable_undo_redo().
var specific_button = document.getElementById("specific");
var random_button = document.getElementById("random");
var prefs_button = document.getElementById("prefs");
var new_button = document.getElementById("new");
var restart_button = document.getElementById("restart");
var undo_button = document.getElementById("undo");
var redo_button = document.getElementById("redo");
var solve_button = document.getElementById("solve");
var save_button = document.getElementById("save");
var load_button = document.getElementById("load");

// A div element enclosing both the puzzle and its status bar, used
// for positioning the resize handle.
var resizable_div = document.getElementById("resizable");

// Alternatively, an extrinsically sized div that we will size the
// puzzle to fit.
var containing_div = document.getElementById("puzzlecanvascontain");

// The current front-end scale factor.  This is how many logical
// pixels (as seen by the mid end and back end) there are to one
// physical pixel in the canvas.  It's applied as a scaling to the
// graphics context and also used to adjust co-ordinates for things
// that don't pass through that scaling.
//
// In order to keep pixel boundaries where the back end expects them
// to be, this is always an integer and at least 1, so it's not
// necessarily the same as window.devicePixelRatio.
var fe_scale = 1;

// Helper function to find the absolute position of a given DOM
// element on a page, by iterating upwards through the DOM finding
// each element's offset from its parent, and thus calculating the
// page-relative position of the target element.
function element_coords(element) {
  var ex = 0,
    ey = 0;
  while (element.offsetParent) {
    ex += element.offsetLeft;
    ey += element.offsetTop;
    element = element.offsetParent;
  }
  return {
    x: ex,
    y: ey
  };
}

// Helper function which is passed a mouse event object and a DOM
// element, and returns the coordinates of the mouse event relative to
// the top left corner of the element by subtracting element_coords
// from event.page{X,Y}.
function relative_mouse_coords(event, element) {
  var ecoords = element_coords(element);
  return {
    x: event.pageX - ecoords.x,
    y: event.pageY - ecoords.y
  };
}

// Higher-level mouse helper function to specifically map mouse
// coordinates into the coordinates on a canvas that appear under it.
// This depends on the details of how a canvas gets scaled by CSS.
function canvas_mouse_coords(event, element) {
  var rcoords = relative_mouse_coords(event, element);
  // Assume that the CSS object-fit property is "fill" (the default).
  var xscale = element.width / element.offsetWidth / fe_scale;
  var yscale = element.height / element.offsetHeight / fe_scale;
  return {
    x: rcoords.x * xscale,
    y: rcoords.y * yscale
  };
}

// Set the font on a CanvasRenderingContext2d based on the CSS font
// for the canvas, the requested size, and whether we want something
// monospaced.
function canvas_set_font(ctx, size, monospaced) {
  var s = window.getComputedStyle(onscreen_canvas);
  // First set something that we're certain will work.  Constructing
  // the font string from the computed style is a bit fragile, so
  // this acts as a fallback.
  ctx.font = `${size}px ` + (monospaced ? "monospace" : "sans-serif");
  // In CSS Fonts Module Level 4, "font-stretch" gets serialised as
  // a percentage, which can't be used in
  // CanvasRenderingContext2d.font, so we omit it.
  ctx.font = `${s.fontStyle} ${s.fontWeight} ${size}px ` + (monospaced ? "monospace" : s.fontFamily);
}

// Enable and disable items in the CSS menus.
function disable_menu_item(item, disabledFlag) {
  item.disabled = disabledFlag;
}

// Dialog-box functions called from both C and JS.
function dialog_init(titletext) {
  // Forward compatibility: Delete form and dimmer if they already
  // exist.
  dlg_dimmer = document.getElementById("dlgdimmer");
  if (dlg_dimmer) dlg_dimmer.parentElement.removeChild(dlg_dimmer);
  dlg_form = document.getElementById("dlgform");
  if (dlg_form) dlg_form.parentElement.removeChild(dlg_form);

  // Create an overlay on the page which darkens everything
  // beneath it.
  dlg_dimmer = document.createElement("div");
  dlg_dimmer.id = "dlgdimmer";

  // Now create a form which sits on top of that in turn.
  dlg_form = document.createElement("form");
  dlg_form.id = "dlgform";
  var title = document.createElement("h2");
  title.appendChild(document.createTextNode(titletext));
  dlg_form.appendChild(title);
  dlg_return_funcs = [];
}
function dialog_launch(ok_function, cancel_function) {
  // Put in the OK and Cancel buttons at the bottom.
  var button;
  if (ok_function) {
    button = document.createElement("input");
    button.type = "button";
    button.value = "OK";
    button.onclick = ok_function;
    dlg_form.appendChild(button);
  }
  if (cancel_function) {
    button = document.createElement("input");
    button.type = "button";
    button.value = "Cancel";
    button.onclick = cancel_function;
    dlg_form.appendChild(button);
  }
  document.body.appendChild(dlg_dimmer);
  document.body.appendChild(dlg_form);
  dlg_form.querySelector("input,select,a").focus();
}
function dialog_cleanup() {
  document.body.removeChild(dlg_dimmer);
  document.body.removeChild(dlg_form);
  dlg_dimmer = dlg_form = null;
  onscreen_canvas.focus();
}
function set_capture(element, event) {
  // This is only needed if we don't have Pointer Events available.
  if (element.setCapture !== undefined && element.setPointerCapture === undefined) {
    element.setCapture(true);
    return;
  }
}

// Init function called early in main().
function initPuzzle() {
  // Construct the off-screen canvas used for double buffering.
  onscreen_canvas = document.getElementById("puzzlecanvas");
  offscreen_canvas = document.createElement("canvas");
  ctx = offscreen_canvas.getContext('2d', {
    alpha: false
  });

  // Stop right-clicks on the puzzle from popping up a context menu.
  // We need those right-clicks!
  onscreen_canvas.oncontextmenu = function (event) {
    return false;
  };

  // Set up mouse handlers. We do a bit of tracking of the currently
  // pressed mouse buttons, to avoid sending mousemoves with no
  // button down (our puzzles don't want those events).
  var mousedown = Module.cwrap('mousedown', 'boolean', ['number', 'number', 'number']);
  var button_phys2log = [null, null, null];
  var buttons_down = function () {
    var i,
      toret = 0;
    for (i = 0; i < 3; i++) if (button_phys2log[i] !== null) toret |= 1 << button_phys2log[i];
    return toret;
  };
  var mousemove = Module.cwrap('mousemove', 'boolean', ['number', 'number', 'number']);
  var mouseup = Module.cwrap('mouseup', 'boolean', ['number', 'number', 'number']);
  function logical_button(event) {
    var logbutton = event.button;
    if (event.shiftKey) logbutton = 1; // Shift-click overrides to middle button
    else if (event.ctrlKey) logbutton = 2; // Ctrl-click overrides to right button
    return logbutton;
  }
  function begin_pointer(event) {
    if (event.button < 0 || event.button >= 3) return;
    var xy = canvas_mouse_coords(event, onscreen_canvas);
    var logbutton = logical_button(event);
    if (mousedown(xy.x, xy.y, logbutton)) event.preventDefault();
    button_phys2log[event.button] = logbutton;
    if (event.pointerId !== undefined && onscreen_canvas.setPointerCapture) {
      try { onscreen_canvas.setPointerCapture(event.pointerId); } catch (e) {}
    } else {
      set_capture(onscreen_canvas, event);
    }
  }
  function move_pointer(event) {
    var down = buttons_down();
    if (down) {
      var xy = canvas_mouse_coords(event, onscreen_canvas);
      if (mousemove(xy.x, xy.y, down)) event.preventDefault();
    }
  }
  function end_pointer(event) {
    if (event.button >= 3) return;
    if (button_phys2log[event.button] !== null) {
      var xy = canvas_mouse_coords(event, onscreen_canvas);
      if (mouseup(xy.x, xy.y, button_phys2log[event.button])) event.preventDefault();
      button_phys2log[event.button] = null;
    }
  }
  if (window.PointerEvent) {
    // Pointer Events unify mouse, pen and touch. Capturing the pointer
    // keeps drag operations alive even when the finger leaves the canvas.
    onscreen_canvas.onpointerdown = function (event) {
      begin_pointer(event);
      // Prevent the browser from interpreting a finger gesture as scrolling
      // or zooming the page while a move is being made on the puzzle.
      if (event.pointerType === 'touch') event.preventDefault();
    };
    onscreen_canvas.onpointermove = move_pointer;
    onscreen_canvas.onpointerup = end_pointer;
    onscreen_canvas.onpointercancel = function (event) {
      end_pointer(event);
      for (var i = 0; i < button_phys2log.length; i++) button_phys2log[i] = null;
    };
  } else {
    // Fallback for older browsers without Pointer Events.
    onscreen_canvas.onmousedown = begin_pointer;
    onscreen_canvas.onmousemove = move_pointer;
    onscreen_canvas.onmouseup = end_pointer;
  }

  // Set up keyboard handlers. We call event.preventDefault()
  // in the keydown handler if it looks like we might have
  // done something with the key.  This means that users
  // of this puzzle collection in other media
  // can indulge their instinct to press ^R for redo, for example,
  // without accidentally reloading the page.
  var key = Module.cwrap('key', 'boolean', ['number', 'string', 'string', 'number', 'number', 'number']);
  onscreen_canvas.onkeydown = function (event) {
    if (key(event.keyCode, event.key, event.char, event.location, event.shiftKey ? 1 : 0, event.ctrlKey ? 1 : 0)) event.preventDefault();
  };

  // command() is a C function called to pass back events which
  // don't fall into other categories like mouse and key events.
  // Mostly those are button presses, but there's also one for the
  // game-type dropdown having been changed.
  command = Module.cwrap('command', 'void', ['number']);

  // Event handlers for buttons and things, which call command().
  if (specific_button) specific_button.onclick = function (event) {
    // Ensure we don't accidentally process these events when a
    // dialog is actually active, e.g. because the button still
    // has keyboard focus
    if (dlg_dimmer === null) command(0);
  };
  if (random_button) random_button.onclick = function (event) {
    if (dlg_dimmer === null) command(1);
  };
  if (new_button) new_button.onclick = function (event) {
    if (dlg_dimmer === null) command(5);
  };
  if (restart_button) restart_button.onclick = function (event) {
    if (dlg_dimmer === null) command(6);
  };
  if (undo_button) undo_button.onclick = function (event) {
    if (dlg_dimmer === null) command(7);
  };
  if (redo_button) redo_button.onclick = function (event) {
    if (dlg_dimmer === null) command(8);
  };
  if (solve_button) solve_button.onclick = function (event) {
    if (dlg_dimmer === null) command(9);
  };
  if (prefs_button) prefs_button.onclick = function (event) {
    if (dlg_dimmer === null) command(10);
  };

  // 'number' is used for C pointers
  var get_save_file = Module.cwrap('get_save_file', 'number', []);
  var free_save_file = Module.cwrap('free_save_file', 'void', ['number']);
  var load_game = Module.cwrap('load_game', 'void', []);
  if (save_button) save_button.onclick = function (event) {
    if (dlg_dimmer === null) {
      var savefile_ptr = get_save_file();
      var savefile_text = UTF8ToString(savefile_ptr);
      free_save_file(savefile_ptr);
      dialog_init("Download saved-game file");
      dlg_form.appendChild(document.createTextNode("Click to download the "));
      var a = document.createElement("a");
      a.download = "puzzle.sav";
      a.href = "data:application/octet-stream," + encodeURIComponent(savefile_text);
      a.appendChild(document.createTextNode("saved-game file"));
      dlg_form.appendChild(a);
      dlg_form.appendChild(document.createTextNode("."));
      dlg_form.appendChild(document.createElement("br"));
      dialog_launch(function (event) {
        dialog_cleanup();
      });
    }
  };
  if (load_button) load_button.onclick = function (event) {
    if (dlg_dimmer === null) {
      var input = document.createElement("input");
      input.type = "file";
      input.multiple = false;
      input.addEventListener("change", function (event) {
        if (input.files.length == 1) {
          var file = input.files.item(0);
          var reader = new FileReader();
          reader.addEventListener("load", function () {
            var pos = 0;
            savefile_read_callback = function (buf, len) {
              if (pos + len > reader.result.byteLength) return false;
              writeArrayToMemory(new Int8Array(reader.result, pos, len), buf);
              pos += len;
              return true;
            };
            load_game();
            savefile_read_callback = null;
          });
          reader.addEventListener("error", function () {
            alert("An error occured while loading the file");
          });
          reader.readAsArrayBuffer(file);
        }
      });
      input.click();
      onscreen_canvas.focus();
    }
  };

  // Find the next or previous item in a menu, or null if there
  // isn't one.  Skip list items that don't have a child (i.e.
  // separators) or whose child is disabled.
  function isuseful(item) {
    return item.querySelector(":scope > :not(:disabled)");
  }
  function nextmenuitem(item) {
    do item = item.nextElementSibling; while (item !== null && !isuseful(item));
    return item;
  }
  function prevmenuitem(item) {
    do item = item.previousElementSibling; while (item !== null && !isuseful(item));
    return item;
  }
  function firstmenuitem(menu) {
    var item = menu && menu.firstElementChild;
    while (item !== null && !isuseful(item)) item = item.nextElementSibling;
    return item;
  }
  function lastmenuitem(menu) {
    var item = menu && menu.lastElementChild;
    while (item !== null && !isuseful(item)) item = item.previousElementSibling;
    return item;
  }
  // Keyboard handlers for the menus.
  function menukey(event) {
    var target = event.target;
    var key = event.key;
    var thisitem = target.closest("li");
    var thismenu = thisitem.closest("ul");
    var targetitem = null;
    var parentitem;
    var parentitem_up = null;
    var parentitem_sideways = null;
    var submenu;
    function ishorizontal(menu) {
      // Which direction does this menu go in?
      var cs = window.getComputedStyle(menu);
      return cs.display == "flex" && cs.flexDirection == "row";
    }
    if (dlg_dimmer !== null) return;
    if (["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].includes(key)) {
      var shortcutitem = thismenu.querySelectorAll(":scope > li:not([role='separator']")[(Number(key) + 9) % 10];
      if (shortcutitem) {
        target = shortcutitem.firstElementChild;
        target.focus();
        thisitem = target.closest("li");
        key = "Enter";
      }
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape", "Backspace", "SoftRight", "F10"].includes(key)) return;
    if (ishorizontal(thismenu)) {
      // Top-level menu bar.
      if (key == "ArrowLeft") targetitem = prevmenuitem(thisitem) || lastmenuitem(thismenu);else if (key == "ArrowRight") targetitem = nextmenuitem(thisitem) || firstmenuitem(thismenu);else if (key == "ArrowUp") targetitem = lastmenuitem(thisitem.querySelector("ul"));else if (key == "ArrowDown" || key == "Enter") targetitem = firstmenuitem(thisitem.querySelector("ul"));
    } else {
      // Ordinary vertical menu.
      parentitem = thismenu.closest("li");
      if (parentitem) {
        if (ishorizontal(parentitem.closest("ul"))) parentitem_up = parentitem;else parentitem_sideways = parentitem;
      }
      if (key == "ArrowUp") targetitem = prevmenuitem(thisitem) || parentitem_up || lastmenuitem(thismenu);else if (key == "ArrowDown") targetitem = nextmenuitem(thisitem) || parentitem_up || firstmenuitem(thismenu);else if (key == "ArrowRight") targetitem = thisitem.querySelector("li") || parentitem_up && nextmenuitem(parentitem_up);else if (key == "Enter") targetitem = thisitem.querySelector("li");else if (key == "ArrowLeft") targetitem = parentitem_sideways || parentitem_up && prevmenuitem(parentitem_up);else if (key == "Backspace") targetitem = parentitem;
    }
    if (targetitem) targetitem.firstElementChild.focus();else if (key == "Enter") target.click();else if (key == "Escape" || key == "SoftRight" || key == "F10" || key == "Backspace")
      // Leave the menu entirely.
      onscreen_canvas.focus();
    // Prevent default even if we didn't do anything, as long as this
    // was an interesting key.
    event.preventDefault();
    event.stopPropagation();
  }
  menuform.addEventListener("keydown", menukey);

  // Open documentation links within the application in KaiOS.
  for (var elem of document.querySelectorAll("#gamemenu a[href]")) {
    elem.addEventListener("click", function (event) {
      window.open(event.target.href);
      event.preventDefault();
    });
  }

  // In IE, the canvas doesn't automatically gain focus on a mouse
  // click, so make sure it does
  onscreen_canvas.addEventListener("mousedown", function (event) {
    onscreen_canvas.focus();
  });

  // In our dialog boxes, Return and Escape should be like pressing
  // OK and Cancel respectively
  document.addEventListener("keydown", function (event) {
    if (dlg_dimmer !== null && event.keyCode == 13) {
      for (var i in dlg_return_funcs) dlg_return_funcs[i]();
      command(3);
      event.preventDefault();
      event.stopPropagation();
    }
    if (dlg_dimmer !== null && event.keyCode == 27) {
      command(4);
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  // Arrange that the softkey labels are clickable.  This logically
  // belongs as a click handler, but by the time the click event
  // fires, the input focus is in the wrong place.
  function button_to_key(key) {
    return function (mevent) {
      mevent.stopPropagation();
      mevent.preventDefault();
      var kevent = new KeyboardEvent("keydown", {
        key: key,
        view: window,
        bubbles: true
      });
      document.activeElement.dispatchEvent(kevent);
    };
  }
  for (var elem of document.querySelectorAll(".lsk")) elem.addEventListener("mousedown", button_to_key("SoftLeft"));
  for (var elem of document.querySelectorAll(".csk")) elem.addEventListener("mousedown", button_to_key("Enter"));
  for (var elem of document.querySelectorAll(".rsk")) elem.addEventListener("mousedown", button_to_key("SoftRight"));
  document.addEventListener("keydown", function (event) {
    // Key to open the menu on KaiOS.
    if ((event.key == "SoftRight" || event.key == "F10") && !menuform.contains(document.activeElement)) {
      menuform.querySelector("li div, li button").focus();
      event.preventDefault();
      event.stopPropagation();
    }
  });

  // Handle "copy" actions.  Browsers don't reliably target the
  // "copy" event at the canvas when it's focused.  Firefox 102
  // targets the containing <div> while Chromium 114 targets the
  // <body>.  So we catch the event at the document level and work
  // out if it's relevant ourselves.
  var get_text_format = Module.cwrap('get_text_format', 'number', []);
  var free_text_format = Module.cwrap('free_text_format', 'void', ['number']);
  document.addEventListener("copy", function (event) {
    // Make sure the target is an ancestor of the canvas.  And if
    // there's a selection assume the user wants to copy that and
    // not the puzzle.
    if (event.target.contains(onscreen_canvas) && window.getSelection().isCollapsed) {
      var ptr = get_text_format();
      event.clipboardData.setData('text/plain', UTF8ToString(ptr));
      event.preventDefault();
      free_text_format(ptr);
    }
  });

  // Event handler to fake :focus-within on browsers too old for
  // it (like KaiOS 2.5).  Browsers without :focus-within are also
  // too old for focusin/out events, so we have to use focus events
  // which don't bubble but can be captured.
  //
  // A button losing focus because it was disabled doesn't generate
  // a blur event, so we do this entirely in the focus handler.
  document.documentElement.addEventListener("focus", function (event) {
    for (var elem = event.target; elem; elem = elem.parentElement) elem.classList.add("focus-within");
    for (elem of Array.from(document.getElementsByClassName("focus-within"))) if (!elem.contains(event.target)) elem.classList.remove("focus-within");
  }, true);

  // Set up the function pointers we haven't already grabbed. 
  dlg_return_sval = Module.cwrap('dlg_return_sval', 'void', ['number', 'string']);
  dlg_return_ival = Module.cwrap('dlg_return_ival', 'void', ['number', 'number']);
  timer_callback = Module.cwrap('timer_callback', 'void', ['number']);
  prefs_load_callback = Module.cwrap('prefs_load_callback', 'void', ['number', 'number']);
  if (resizable_div !== null) {
    var resize_handle = document.getElementById("resizehandle");
    var resize_xbase = null,
      resize_ybase = null,
      restore_pending = false;
    var resize_xoffset = null,
      resize_yoffset = null;
    var resize_puzzle = Module.cwrap('resize_puzzle', 'void', ['number', 'number']);
    var restore_puzzle_size = Module.cwrap('restore_puzzle_size', 'void', []);
    resize_handle.oncontextmenu = function (event) {
      return false;
    };
    resize_handle.onpointerdown = function (event) {
      resize_handle.setPointerCapture(event.pointerId);
    };
    resize_handle.onmousedown = function (event) {
      if (event.button == 0) {
        var xy = element_coords(onscreen_canvas);
        resize_xbase = xy.x + onscreen_canvas.offsetWidth / 2;
        resize_ybase = xy.y;
        resize_xoffset = xy.x + onscreen_canvas.offsetWidth - event.pageX;
        resize_yoffset = xy.y + onscreen_canvas.offsetHeight - event.pageY;
      } else {
        restore_pending = true;
      }
      set_capture(resize_handle, event);
      event.preventDefault();
    };
    window.addEventListener("mousemove", function (event) {
      if (resize_xbase !== null && resize_ybase !== null) {
        var dpr = window.devicePixelRatio || 1;
        resize_puzzle((event.pageX + resize_xoffset - resize_xbase) * dpr * 2, (event.pageY + resize_yoffset - resize_ybase) * dpr);
        event.preventDefault();
        // Chrome insists on selecting text during a resize drag
        // no matter what I do
        if (window.getSelection) window.getSelection().removeAllRanges();else document.selection.empty();
      }
    });
    window.addEventListener("mouseup", function (event) {
      if (resize_xbase !== null && resize_ybase !== null) {
        resize_xbase = null;
        resize_ybase = null;
        onscreen_canvas.focus(); // return focus to the puzzle
        event.preventDefault();
      } else if (restore_pending) {
        // If you have the puzzle at larger than normal size and
        // then right-click to restore, I haven't found any way to
        // stop Chrome and IE popping up a context menu on the
        // revealed piece of document when you release the button
        // except by putting the actual restore into a setTimeout.
        // Gah.
        setTimeout(function () {
          restore_pending = false;
          restore_puzzle_size();
          onscreen_canvas.focus();
        }, 20);
        event.preventDefault();
      }
    });
  }
  var rescale_puzzle = Module.cwrap('rescale_puzzle', 'void', []);
  /*
   * If the puzzle is sized to fit the page, try to detect changes
   * of size of the containing element.  Ideally this would use a
   * ResizeObserver on the containing_div, but I want this to work
   * on KaiOS 2.5, which doesn't have ResizeObserver.  Instead we
   * watch events that might indicate that the div has changed size.
   */
  if (containing_div !== null) {
    var resize_handler = function (event) {
      rescale_puzzle();
    };
    window.addEventListener("resize", resize_handler);
    // Also catch the point when the document finishes loading,
    // since sometimes we seem to get the div's size too early.
    window.addEventListener("load", resize_handler);
  }
}
function post_init() {
  /*
   * Arrange to detect changes of device pixel ratio.  Adapted from
   * <https://developer.mozilla.org/en-US/docs/Web/API/Window/
   * devicePixelRatio> (CC0) to work on older browsers.
   */
  var rescale_puzzle = Module.cwrap('rescale_puzzle', 'void', []);
  var mql = null;
  var update_pixel_ratio = function () {
    var dpr = window.devicePixelRatio;
    if (mql !== null) mql.removeListener(update_pixel_ratio);
    mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    mql.addListener(update_pixel_ratio);
    rescale_puzzle();
  };
  update_pixel_ratio();
  // If we get here with everything having gone smoothly, i.e.
  // we haven't crashed for one reason or another during setup, then
  // it's probably safe to hide the 'sorry, no puzzle here' div and
  // show the div containing the actual puzzle.
  var apology = document.getElementById("apology");
  if (apology !== null) apology.style.display = "none";
  document.getElementById("puzzle").style.display = "";

  // Default to giving keyboard focus to the puzzle.
  onscreen_canvas.focus();
}
// end include: /tmp/bob.1.0/puzzles/emccpre.js

// Sometimes an existing Module object exists with properties
// meant to overwrite the default module functionality. Here
// we collect those properties and reapply _after_ we configure
// the current environment's defaults to avoid having to be so
// defensive during initialization.
var moduleOverrides = Object.assign({}, Module);
var arguments_ = [];
var thisProgram = './this.program';
var quit_ = (status, toThrow) => {
  throw toThrow;
};

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = '';
function locateFile(path) {
  if (Module['locateFile']) {
    return Module['locateFile'](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var readAsync, readBinary;
if (ENVIRONMENT_IS_SHELL) {
  if (typeof process == 'object' && typeof require === 'function' || typeof window == 'object' || typeof importScripts == 'function') throw new Error('not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)');
} else
  // Note that this includes Node.js workers when relevant (pthreads is enabled).
  // Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
  // ENVIRONMENT_IS_NODE.
  if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
    if (ENVIRONMENT_IS_WORKER) {
      // Check worker, not web, since window could be polyfilled
      scriptDirectory = self.location.href;
    } else if (typeof document != 'undefined' && document.currentScript) {
      // web
      scriptDirectory = document.currentScript.src;
    }
    // blob urls look like blob:http://site.com/etc/etc and we cannot infer anything from them.
    // otherwise, slice off the final part of the url to find the script directory.
    // if scriptDirectory does not contain a slash, lastIndexOf will return -1,
    // and scriptDirectory will correctly be replaced with an empty string.
    // If scriptDirectory contains a query (starting with ?) or a fragment (starting with #),
    // they are removed because they could contain a slash.
    if (scriptDirectory.startsWith('blob:')) {
      scriptDirectory = '';
    } else {
      scriptDirectory = scriptDirectory.substr(0, scriptDirectory.replace(/[?#].*/, '').lastIndexOf('/') + 1);
    }
    if (!(typeof window == 'object' || typeof importScripts == 'function')) throw new Error('not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)');
    {
      // include: web_or_worker_shell_read.js
      readAsync = url => {
        assert(!isFileURI(url), "readAsync does not work with file:// URLs");
        return fetch(url, {
          credentials: 'same-origin'
        }).then(response => {
          if (response.ok) {
            return response.arrayBuffer();
          }
          return Promise.reject(new Error(response.status + ' : ' + response.url));
        });
      };
      // end include: web_or_worker_shell_read.js
    }
  } else {
    throw new Error('environment detection error');
  }
var out = Module['print'] || console.log.bind(console);
var err = Module['printErr'] || console.error.bind(console);

// Merge back in the overrides
Object.assign(Module, moduleOverrides);
// Free the object hierarchy contained in the overrides, this lets the GC
// reclaim data used.
moduleOverrides = null;
checkIncomingModuleAPI();

// Emit code to handle expected values on the Module object. This applies Module.x
// to the proper local x. This has two benefits: first, we only emit it if it is
// expected to arrive, and second, by using a local everywhere else that can be
// minified.

if (Module['arguments']) arguments_ = Module['arguments'];
legacyModuleProp('arguments', 'arguments_');
if (Module['thisProgram']) thisProgram = Module['thisProgram'];
legacyModuleProp('thisProgram', 'thisProgram');
if (Module['quit']) quit_ = Module['quit'];
legacyModuleProp('quit', 'quit_');

// perform assertions in shell.js after we set up out() and err(), as otherwise if an assertion fails it cannot print the message
// Assertions on removed incoming Module JS APIs.
assert(typeof Module['memoryInitializerPrefixURL'] == 'undefined', 'Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['pthreadMainPrefixURL'] == 'undefined', 'Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['cdInitializerPrefixURL'] == 'undefined', 'Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['filePackagePrefixURL'] == 'undefined', 'Module.filePackagePrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['read'] == 'undefined', 'Module.read option was removed');
assert(typeof Module['readAsync'] == 'undefined', 'Module.readAsync option was removed (modify readAsync in JS)');
assert(typeof Module['readBinary'] == 'undefined', 'Module.readBinary option was removed (modify readBinary in JS)');
assert(typeof Module['setWindowTitle'] == 'undefined', 'Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)');
assert(typeof Module['TOTAL_MEMORY'] == 'undefined', 'Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY');
legacyModuleProp('asm', 'wasmExports');
legacyModuleProp('readAsync', 'readAsync');
legacyModuleProp('readBinary', 'readBinary');
legacyModuleProp('setWindowTitle', 'setWindowTitle');
var IDBFS = 'IDBFS is no longer included by default; build with -lidbfs.js';
var PROXYFS = 'PROXYFS is no longer included by default; build with -lproxyfs.js';
var WORKERFS = 'WORKERFS is no longer included by default; build with -lworkerfs.js';
var FETCHFS = 'FETCHFS is no longer included by default; build with -lfetchfs.js';
var ICASEFS = 'ICASEFS is no longer included by default; build with -licasefs.js';
var JSFILEFS = 'JSFILEFS is no longer included by default; build with -ljsfilefs.js';
var OPFS = 'OPFS is no longer included by default; build with -lopfs.js';
var NODEFS = 'NODEFS is no longer included by default; build with -lnodefs.js';
assert(!ENVIRONMENT_IS_WORKER, 'worker environment detected but not enabled at build time.  Add `worker` to `-sENVIRONMENT` to enable.');
assert(!ENVIRONMENT_IS_NODE, 'node environment detected but not enabled at build time.  Add `node` to `-sENVIRONMENT` to enable.');
assert(!ENVIRONMENT_IS_SHELL, 'shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.');

// end include: shell.js

// include: preamble.js
// === Preamble library stuff ===

// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html

var wasmBinary = Uint8Array.from(atob('AGFzbQEAAAABwAIuYAN/f38AYAF/AGACf38Bf2ADf39/AX9gAX8Bf2ACf38AYAABf2AAAGAEf39/fwBgBX9/f39/AGAEf39/fwF/YAZ/f39/f38AYAV/fn5+fgBgCH9/f39/f39/AGAEf39/fwF9YAd/f39/f39/AGAGf39/f39/AX9gCH9/f39/f319AGAEf35+fwBgAn99AGAFf39/f38Bf2AHf39/f39/fwF/YAJ8fwF8YAZ/fH9/f38Bf2ACfn8Bf2AEfn5+fgF/YAABfGAGfX19fX9/AGAFf39/f3wAYAR/f3x8AX9gAXwAYAd/fX19fX1/AGABfwF8YAJ/fgBgAn5+AX9gA39+fgBgAn9/AX5gAn9/AXxgA35/fwF/YAF8AX5gBH9/f34BfmADf39+AGACf3wAYAJ+fgF8YAJ+fgF9YAN/fn8BfgLJCjQDZW52DV9fYXNzZXJ0X2ZhaWwACANlbnYOanNfZ2V0X2RhdGVfNjQAAQNlbnYManNfZXJyb3JfYm94AAEDZW52E2pzX2RlYWN0aXZhdGVfdGltZXIABwNlbnYRanNfYWN0aXZhdGVfdGltZXIABwNlbnYcanNfY2FudmFzX2dldF9wcmVmZXJyZWRfc2l6ZQACA2Vudhlqc19nZXRfZGV2aWNlX3BpeGVsX3JhdGlvABoDZW52EmpzX2NhbnZhc19zZXRfc2l6ZQAAA2VudhFqc19kZWZhdWx0X2NvbG91cgABA2VudhNqc19lbmFibGVfdW5kb19yZWRvAAUDZW52FGpzX3VwZGF0ZV9rZXlfbGFiZWxzAAUDZW52FmpzX2dldF9zZWxlY3RlZF9wcmVzZXQABgNlbnYPanNfZm9jdXNfY2FudmFzAAcDZW52DmpzX2RpYWxvZ19pbml0AAEDZW52EGpzX2RpYWxvZ19zdHJpbmcAAANlbnYRanNfZGlhbG9nX2Jvb2xlYW4AAANlbnYRanNfZGlhbG9nX2Nob2ljZXMACANlbnYQanNfZGlhbG9nX2xhdW5jaAAHA2VudhBqc19zZWxlY3RfcHJlc2V0AAEDZW52EWpzX2RpYWxvZ19jbGVhbnVwAAcDZW52EGpzX3NhdmVmaWxlX3JlYWQAAgNlbnYUanNfdXBkYXRlX3Blcm1hbGlua3MABQNlbnYOanNfaW5pdF9wdXp6bGUABwNlbnYNanNfbG9hZF9wcmVmcwABA2Vudhpqc19jYW52YXNfcmVtb3ZlX3N0YXR1c2JhcgAHA2Vudg1qc19hZGRfcHJlc2V0AAADZW52F2pzX3JlbW92ZV90eXBlX2Ryb3Bkb3duAAcDZW52FmpzX3JlbW92ZV9zb2x2ZV9idXR0b24ABwNlbnYNanNfc2V0X2NvbG91cgAFA2Vudgxqc19wb3N0X2luaXQABwNlbnYVanNfYWRkX3ByZXNldF9zdWJtZW51AAIDZW52DWpzX3NhdmVfcHJlZnMAAQNlbnYcanNfY2FudmFzX2ZpbmRfZm9udF9taWRwb2ludAACA2VudhNqc19jYW52YXNfZHJhd190ZXh0AA8DZW52E2pzX2NhbnZhc19kcmF3X2xpbmUAGwNlbnYVanNfY2FudmFzX25ld19ibGl0dGVyAAADZW52FmpzX2NhbnZhc19mcmVlX2JsaXR0ZXIAAQNlbnYTanNfY2FudmFzX2RyYXdfcmVjdAALA2VudhNqc19jYW52YXNfZHJhd19wb2x5AAkDZW52FWpzX2NhbnZhc19kcmF3X2NpcmNsZQALA2VudhVqc19jYW52YXNfZHJhd191cGRhdGUACQNlbnYOanNfY2FudmFzX2NsaXAACQNlbnYQanNfY2FudmFzX3VuY2xpcAABA2VudhRqc19jYW52YXNfc3RhcnRfZHJhdwABA2VudhJqc19jYW52YXNfZW5kX2RyYXcAAQNlbnYUanNfY2FudmFzX3N0YXR1c19iYXIABQNlbnYWanNfY2FudmFzX2JsaXR0ZXJfc2F2ZQAIA2VudhZqc19jYW52YXNfYmxpdHRlcl9sb2FkAAgDZW52FV9lbXNjcmlwdGVuX21lbWNweV9qcwAAFndhc2lfc25hcHNob3RfcHJldmlldzERZW52aXJvbl9zaXplc19nZXQAAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC2Vudmlyb25fZ2V0AAIDZW52FmVtc2NyaXB0ZW5fcmVzaXplX2hlYXAABAOyArACBwYDBAUBAgQEAgoEAQIDBAQBCgQFBAEEAAIAAxAIAgUCAwkIAgIBBREPCA0PCA4ODQQDDQsLCwkBAQUDBQgIBAECBAEECgEcHQEFAQEBAQAAAQEFAQMBAwoDAgUAAAgEBAEKCgQEBAITAgYCAgACCgUFBAQAAwIDBAQDBAIDFAMBAAICAhUAAQEABQUAAgICAQUFAQEeBwcFBQUDBwMDEAIFBQEBBwEBBgEGAAEHAwcFAwIFAQ0LAwUDHyAEBAMDBAEEBAcEAwMBAQYHAwMCAgICAgICBAMDAwIhBAYWDBIiDCMIBAsPJAglBAQCFgMUFQAECCYYGAkDFwUnCgMDKAQGBgYHCgQDBAIpAwMDAgYEBAMBAgIFDBIZGQwqEwUFBgYSDAwMKywHBgYGAQQGBAQFAXABQEAFBwEBggKAgAIGEgN/AUGAgAQLfwFBAAt/AUEACwfIBB8GbWVtb3J5AgARX193YXNtX2NhbGxfY3RvcnMANBlfX2luZGlyZWN0X2Z1bmN0aW9uX3RhYmxlAQAGbWFsbG9jAMUCBGZyZWUAxwIOdGltZXJfY2FsbGJhY2sAyQEOcmVzY2FsZV9wdXp6bGUAygENcmVzaXplX3B1enpsZQDMARNyZXN0b3JlX3B1enpsZV9zaXplAM0BCW1vdXNlZG93bgDPAQdtb3VzZXVwANEBCW1vdXNlbW92ZQDSAQNrZXkA0wEPZGxnX3JldHVybl9zdmFsANUBD2RsZ19yZXR1cm5faXZhbADWAQdjb21tYW5kANcBD2dldF90ZXh0X2Zvcm1hdADcARBmcmVlX3RleHRfZm9ybWF0AN0BDWdldF9zYXZlX2ZpbGUA3gEOZnJlZV9zYXZlX2ZpbGUA4AEJbG9hZF9nYW1lAOEBE3ByZWZzX2xvYWRfY2FsbGJhY2sA5AEQX19tYWluX2FyZ2NfYXJndgDmAQZmZmx1c2gA4wIVZW1zY3JpcHRlbl9zdGFja19pbml0ANwCGWVtc2NyaXB0ZW5fc3RhY2tfZ2V0X2ZyZWUA3QIZZW1zY3JpcHRlbl9zdGFja19nZXRfYmFzZQDeAhhlbXNjcmlwdGVuX3N0YWNrX2dldF9lbmQA3wIZX2Vtc2NyaXB0ZW5fc3RhY2tfcmVzdG9yZQDgAhdfZW1zY3JpcHRlbl9zdGFja19hbGxvYwDhAhxlbXNjcmlwdGVuX3N0YWNrX2dldF9jdXJyZW50AOICCVYBAEEBCz81Njg6OTc7PD0+QUJDRUZHSElKS0xOT1BUVldYWVtcYmNkZYMBiwGzAd8B4gHlAegB6QEl6gEmJygpKissLesB7AEuL+0B7gGt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IAYoAmwhtAEgBigCcCG1ASCzASC0ASC1ARBmIbYBIAYoAmwhtwEgtwEgtgE2ApABDAELIAYoAmwhuAFBACG5ASC4ASC5ATYCkAELIAYoAmwhugFBACG7ASC6ASC7ATYCmAEgBigCbCG8AUEAIb0BILwBIL0BNgKcASAGKAJsIb4BQQAhvwEgvgEgvwE2AqABIAYoAmwhwAFBASHBASDAASDBAToAwAEgBigCbCHCASDCARB3IAYoAmghwwEgwwEQdCAGKAJsIcQBQYABIcUBIAYgxQFqIcYBIMYBJAAgxAEPC/ICAS9/IwAhAUEQIQIgASACayEDIAMkACADIAA2AgwCQANAIAMoAgwhBCAEKAIsIQVBACEGIAUgBkohB0EBIQggByAIcSEJIAlFDQEgAygCDCEKIAooAiwhC0F/IQwgCyAMaiENIAogDTYCLCADKAIMIQ4gDigCCCEPIA8oAkwhECADKAIMIREgESgCOCESIAMoAgwhEyATKAIsIRRBDCEVIBQgFWwhFiASIBZqIRcgFygCACEYIBggEBEBACADKAIMIRkgGSgCOCEaIAMoAgwhGyAbKAIsIRxBDCEdIBwgHWwhHiAaIB5qIR8gHygCBCEgICAQdAwACwALIAMoAgwhISAhKAJgISJBACEjICIgI0chJEEBISUgJCAlcSEmAkAgJkUNACADKAIMIScgJygCCCEoICgoAqQBISkgAygCDCEqICooApABISsgAygCDCEsICwoAmAhLSArIC0gKREFAAtBECEuIAMgLmohLyAvJAAPC5oKApABfwV8IwAhBUEwIQYgBSAGayEHIAckACAHIAA2AiwgByABNgIoIAcgAjYCJCADIQggByAIOgAjIAcgBDkDGCAHKAIsIQkgCSgCYCEKQQAhCyAKIAtHIQxBASENIAwgDXEhDgJAIA5FDQAgBygCLCEPIA8oAqwBIRBBACERIBAgEUohEkEBIRMgEiATcSEUIBRFDQAgBygCLCEVIBUoAgghFiAWKAKkASEXIAcoAiwhGCAYKAKQASEZIAcoAiwhGiAaKAJgIRsgGSAbIBcRBQAgBygCLCEcIBwoAgghHSAdKAKgASEeIAcoAiwhHyAfKAKQASEgIAcoAiwhISAhKAI4ISIgIigCACEjICAgIyAeEQIAISQgBygCLCElICUgJDYCYCAHKAIsISZB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AkAgAkH/AXFBVWoOAwECAAILQQAhAwsgACwAACECIAAhAQtBACEAAkAgAkFQaiICQQlLDQBBACEAA0AgAEEKbCACayEAIAEsAAEhAiABQQFqIQEgAkFQaiICQQpJDQALC0EAIABrIAAgAxsLEAAgAEEgRiAAQXdqQQVJcguQBAEDfwJAIAJBgARJDQAgACABIAIQMCAADwsgACACaiEDAkACQCABIABzQQNxDQACQAJAIABBA3ENACAAIQIMAQsCQCACDQAgACECDAELIAAhAgNAIAIgAS0AADoAACABQQFqIQEgAkEBaiICQQNxRQ0BIAIgA0kNAAsLIANBfHEhBAJAIANBwABJDQAgAiAEQUBqIgVLDQADQCACIAEoAgA2AgAgAiABKAIENgIEIAIgASgCCDYCCCACIAEoAgw2AgwgAiABKAIQNgIQIAIgASgCFDYCFCACIAEoAhg2AhggAiABKAIcNgIcIAIgASgCIDYCICACIAEoAiQ2AiQgAiABKAIoNgIoIAIgASgCLDYCLCACIAEoAjA2AjAgAiABKAI0NgI0IAIgASgCODYCOCACIAEoAjw2AjwgAUHAAGohASACQcAAaiICIAVNDQALCyACIARPDQEDQCACIAEoAgA2AgAgAUEEaiEBIAJBBGoiAiAESQ0ADAILAAsCQCADQQRPDQAgACECDAELAkAgA0F8aiIEIABPDQAgACECDAELIAAhAgNAIAIgAS0AADoAACACIAEtAAE6AAEgAiABLQACOgACIAIgAS0AAzoAAyABQQRqIQEgAkEEaiICIARNDQALCwJAIAIgA08NAANAIAIgAS0AADoAACABQQFqIQEgAkEBaiICIANHDQALCyAAC/ICAgN/AX4CQCACRQ0AIAAgAToAACAAIAJqIgNBf2ogAToAACACQQNJDQAgACABOgACIAAgAToAASADQX1qIAE6AAAgA0F+aiABOgAAIAJBB0kNACAAIAE6AAMgA0F8aiABOgAAIAJBCUkNACAAQQAgAGtBA3EiBGoiAyABQf8BcUGBgoQIbCIBNgIAIAMgAiAEa0F8cSIEaiICQXxqIAE2AgAgBEEJSQ0AIAMgATYCCCADIAE2AgQgAkF4aiABNgIAIAJBdGogATYCACAEQRlJDQAgAyABNgIYIAMgATYCFCADIAE2AhAgAyABNgIMIAJBcGogATYCACACQWxqIAE2AgAgAkFoaiABNgIAIAJBZGogATYCACAEIANBBHFBGHIiBWsiAkEgSQ0AIAGtQoGAgIAQfiEGIAMgBWohAQNAIAEgBjcDGCABIAY3AxAgASAGNwMIIAEgBjcDACABQSBqIQEgAkFgaiICQR9LDQALCyAACwQAQQELAgALgQEBAn8gACAAKAJIIgFBf2ogAXI2AkgCQCAAKAIUIAAoAhxGDQAgAEEAQQAgACgCJBEDABoLIABBADYCHCAAQgA3AxACQCAAKAIAIgFBBHFFDQAgACABQSByNgIAQX8PCyAAIAAoAiwgACgCMGoiAjYCCCAAIAI2AgQgAUEbdEEfdQtBAQJ/IwBBEGsiASQAQX8hAgJAIAAQ9gENACAAIAFBD2pBASAAKAIgEQMAQQFHDQAgAS0ADyECCyABQRBqJAAgAgt9AQJ/IwBBEGsiACQAAkAgAEEMaiAAQQhqEDENAEEAIAAoAgxBAnRBBGoQxQIiATYC2K4EIAFFDQACQCAAKAIIEMUCIgFFDQBBACgC2K4EIAAoAgxBAnRqQQA2AgBBACgC2K4EIAEQMkUNAQtBAEEANgLYrgQLIABBEGokAAuIAQEEfwJAIABBPRCEAiIBIABHDQBBAA8LQQAhAgJAIAAgASAAayIDai0AAA0AQQAoAtiuBCIBRQ0AIAEoAgAiBEUNAAJAA0ACQCAAIAQgAxCKAg0AIAEoAgAgA2oiBC0AAEE9Rg0CCyABKAIEIQQgAUEEaiEBIAQNAAwCCwALIARBAWohAgsgAgvpAQECfyACQQBHIQMCQAJAAkAgAEEDcUUNACACRQ0AIAFB/wFxIQQDQCAALQAAIARGDQIgAkF/aiICQQBHIQMgAEEBaiIAQQNxRQ0BIAINAAsLIANFDQECQCAALQAAIAFB/wFxRg0AIAJBBEkNACABQf8BcUGBgoQIbCEEA0BBgIKECCAAKAIAIARzIgNrIANyQYCBgoR4cUGAgYKEeEcNAiAAQQRqIQAgAkF8aiICQQNLDQALCyACRQ0BCyABQf8BcSEDA0ACQCAALQAAIANHDQAgAA8LIABBAWohACACQX9qIgINAAsLQQALhwEBAn8CQAJAAkAgAkEESQ0AIAEgAHJBA3ENAQNAIAAoAgAgASgCAEcNAiABQQRqIQEgAEEEaiEAIAJBfGoiAkEDSw0ACwsgAkUNAQsCQANAIAAtAAAiAyABLQAAIgRHDQEgAUEBaiEBIABBAWohACACQX9qIgJFDQIMAAsACyADIARrDwtBAAsCAAsCAAsNAEHcrgQQ/AFB4K4ECwkAQdyuBBD9AQsoAQF/IwBBEGsiAyQAIAMgAjYCDCAAIAEgAhCyAiECIANBEGokACACCygBAX8jAEEQayIDJAAgAyACNgIMIAAgASACEL8CIQIgA0EQaiQAIAILEgAgACAAEIkCaiABEIcCGiAACxoAIAAgARCEAiIAQQAgAC0AACABQf8BcUYbC/kBAQN/AkACQAJAAkAgAUH/AXEiAkUNAAJAIABBA3FFDQAgAUH/AXEhAwNAIAAtAAAiBEUNBSAEIANGDQUgAEEBaiIAQQNxDQALC0GAgoQIIAAoAgAiA2sgA3JBgIGChHhxQYCBgoR4Rw0BIAJBgYKECGwhAgNAQYCChAggAyACcyIEayAEckGAgYKEeHFBgIGChHhHDQIgACgCBCEDIABBBGoiBCEAIANBgIKECCADa3JBgIGChHhxQYCBgoR4Rg0ADAMLAAsgACAAEIkCag8LIAAhBAsDQCAEIgAtAAAiA0UNASAAQQFqIQQgAyABQf8BcUcNAAsLIAALWQECfyABLQAAIQICQCAALQAAIgNFDQAgAyACQf8BcUcNAANAIAEtAAEhAiAALQABIgNFDQEgAUEBaiEBIABBAWohACADIAJB/wFxRg0ACwsgAyACQf8BcWsL5gEBAn8CQAJAAkAgASAAc0EDcUUNACABLQAAIQIMAQsCQCABQQNxRQ0AA0AgACABLQAAIgI6AAAgAkUNAyAAQQFqIQAgAUEBaiIBQQNxDQALC0GAgoQIIAEoAgAiAmsgAnJBgIGChHhxQYCBgoR4Rw0AA0AgACACNgIAIABBBGohACABKAIEIQIgAUEEaiIDIQEgAkGAgoQIIAJrckGAgYKEeHFBgIGChHhGDQALIAMhAQsgACACOgAAIAJB/wFxRQ0AA0AgACABLQABIgI6AAEgAEEBaiEAIAFBAWohASACDQALCyAACwwAIAAgARCGAhogAAvOAQEDfyMAQSBrIgIkAAJAAkACQCABLAAAIgNFDQAgAS0AAQ0BCyAAIAMQhAIhBAwBCyACQQBBIBDzARoCQCABLQAAIgNFDQADQCACIANBA3ZBHHFqIgQgBCgCAEEBIAN0cjYCACABLQABIQMgAUEBaiEBIAMNAAsLIAAhBCAALQAAIgNFDQAgACEBA0ACQCACIANBA3ZBHHFqKAIAIAN2QQFxRQ0AIAEhBAwCCyABLQABIQMgAUEBaiIEIQEgAw0ACwsgAkEgaiQAIAQgAGsLiAEBA38gACEBAkACQCAAQQNxRQ0AAkAgAC0AAA0AIAAgAGsPCyAAIQEDQCABQQFqIgFBA3FFDQEgAS0AAA0ADAILAAsDQCABIgJBBGohAUGAgoQIIAIoAgAiA2sgA3JBgIGChHhxQYCBgoR4Rg0ACwNAIAIiAUEBaiECIAEtAAANAAsLIAEgAGsLdQECfwJAIAINAEEADwsCQAJAIAAtAAAiAw0AQQAhAAwBCwJAA0AgA0H/AXEgAS0AACIERw0BIARFDQEgAkF/aiICRQ0BIAFBAWohASAALQABIQMgAEEBaiEAIAMNAAtBACEDCyADQf8BcSEACyAAIAEtAABrC4ECAQF/AkACQAJAAkAgASAAc0EDcQ0AIAJBAEchAwJAIAFBA3FFDQAgAkUNAANAIAAgAS0AACIDOgAAIANFDQUgAEEBaiEAIAJBf2oiAkEARyEDIAFBAWoiAUEDcUUNASACDQALCyADRQ0CIAEtAABFDQMgAkEESQ0AA0BBgIKECCABKAIAIgNrIANyQYCBgoR4cUGAgYKEeEcNAiAAIAM2AgAgAEEEaiEAIAFBBGohASACQXxqIgJBA0sNAAsLIAJFDQELA0AgACABLQAAIgM6AAAgA0UNAiAAQQFqIQAgAUEBaiEBIAJBf2oiAg0ACwtBACECCyAAQQAgAhDzARogAAsOACAAIAEgAhCLAhogAAvkAQEDfyMAQSBrIgJBGGpCADcDACACQRBqQgA3AwAgAkIANwMIIAJCADcDAAJAIAEtAAAiAw0AQQAPCwJAIAEtAAENACAAIQEDQCABIgRBAWohASAELQAAIANGDQALIAQgAGsPCwNAIAIgA0EDdkEccWoiBCAEKAIAQQEgA3RyNgIAIAEtAAEhAyABQQFqIQEgAw0ACyAAIQQCQCAALQAAIgNFDQAgACEBA0ACQCACIANBA3ZBHHFqKAIAIAN2QQFxDQAgASEEDAILIAEtAAEhAyABQQFqIgQhASADDQALCyAEIABrC0cBAn8gACABNwNwIAAgACgCLCAAKAIEIgJrrDcDeCAAKAIIIQMCQCABUA0AIAMgAmusIAFXDQAgAiABp2ohAwsgACADNgJoC90BAgN/An4gACkDeCAAKAIEIgEgACgCLCICa6x8IQQCQAJAAkAgACkDcCIFUA0AIAQgBVkNAQsgABD3ASICQX9KDQEgACgCBCEBIAAoAiwhAgsgAEJ/NwNwIAAgATYCaCAAIAQgAiABa6x8NwN4QX8PCyAEQgF8IQQgACgCBCEBIAAoAgghAwJAIAApA3AiBUIAUQ0AIAUgBH0iBSADIAFrrFkNACABIAWnaiEDCyAAIAM2AmggACAEIAAoAiwiAyABa6x8NwN4AkAgASADSw0AIAFBf2ogAjoAAAsgAgsGAEHkrgQLrgEAAkACQCABQYAISA0AIABEAAAAAAAA4H+iIQACQCABQf8PTw0AIAFBgXhqIQEMAgsgAEQAAAAAAADgf6IhACABQf0XIAFB/RdJG0GCcGohAQwBCyABQYF4Sg0AIABEAAAAAAAAYAOiIQACQCABQbhwTQ0AIAFByQdqIQEMAQsgAEQAAAAAAABgA6IhACABQfBoIAFB8GhLG0GSD2ohAQsgACABQf8Haq1CNIa/ogs8ACAAIAE3AwAgACAEQjCIp0GAgAJxIAJCgICAgICAwP//AINCMIincq1CMIYgAkL///////8/g4Q3AwgL5wIBAX8jAEHQAGsiBCQAAkACQCADQYCAAUgNACAEQSBqIAEgAkIAQoCAgICAgID//wAQ1wIgBEEgakEIaikDACECIAQpAyAhAQJAIANB//8BTw0AIANBgYB/aiEDDAILIARBEGogASACQgBCgICAgICAgP//ABDXAiADQf3/AiADQf3/AkkbQYKAfmohAyAEQRBqQQhqKQMAIQIgBCkDECEBDAELIANBgYB/Sg0AIARBwABqIAEgAkIAQoCAgICAgIA5ENcCIARBwABqQQhqKQMAIQIgBCkDQCEBAkAgA0H0gH5NDQAgA0GN/wBqIQMMAQsgBEEwaiABIAJCAEKAgICAgICAORDXAiADQeiBfSADQeiBfUsbQZr+AWohAyAEQTBqQQhqKQMAIQIgBCkDMCEBCyAEIAEgAkIAIANB//8Aaq1CMIYQ1wIgACAEQQhqKQMANwMIIAAgBCkDADcDACAEQdAAaiQAC0sCAX4CfyABQv///////z+DIQICQAJAIAFCMIinQf//AXEiA0H//wFGDQBBBCEEIAMNAUECQQMgAiAAhFAbDwsgAiAAhFAhBAsgBAvSBgIEfwN+IwBBgAFrIgUkAAJAAkACQCADIARCAEIAEM0CRQ0AIAMgBBCUAkUNACACQjCIpyIGQf//AXEiB0H//wFHDQELIAVBEGogASACIAMgBBDXAiAFIAUpAxAiBCAFQRBqQQhqKQMAIgMgBCADEM8CIAVBCGopAwAhAiAFKQMAIQQMAQsCQCABIAJC////////////AIMiCSADIARC////////////AIMiChDNAkEASg0AAkAgASAJIAMgChDNAkUNACABIQQMAgsgBUHwAGogASACQgBCABDXAiAFQfgAaikDACECIAUpA3AhBAwBCyAEQjCIp0H//wFxIQgCQAJAIAdFDQAgASEEDAELIAVB4ABqIAEgCUIAQoCAgICAgMC7wAAQ1wIgBUHoAGopAwAiCUIwiKdBiH9qIQcgBSkDYCEECwJAIAgNACAFQdAAaiADIApCAEKAgICAgIDAu8AAENcCIAVB2ABqKQMAIgpCMIinQYh/aiEIIAUpA1AhAwsgCkL///////8/g0KAgICAgIDAAIQhCyAJQv///////z+DQoCAgICAgMAAhCEJAkAgByAITA0AA0ACQAJAIAkgC30gBCADVK19IgpCAFMNAAJAIAogBCADfSIEhEIAUg0AIAVBIGogASACQgBCABDXAiAFQShqKQMAIQIgBSkDICEEDAULIApCAYYgBEI/iIQhCQwBCyAJQgGGIARCP4iEIQkLIARCAYYhBCAHQX9qIgcgCEoNAAsgCCEHCwJAAkAgCSALfSAEIANUrX0iCkIAWQ0AIAkhCgwBCyAKIAQgA30iBIRCAFINACAFQTBqIAEgAkIAQgAQ1wIgBUE4aikDACECIAUpAzAhBAwBCwJAIApC////////P1YNAANAIARCP4ghAyAHQX9qIQcgBEIBhiEEIAMgCkIBhoQiCkKAgICAgIDAAFQNAAsLIAZBgIACcSEIAkAgB0EASg0AIAVBwABqIAQgCkL///////8/gyAHQfgAaiAIcq1CMIaEQgBCgICAgICAwMM/ENcCIAVByABqKQMAIQIgBSkDQCEEDAELIApC////////P4MgByAIcq1CMIaEIQILIAAgBDcDACAAIAI3AwggBUGAAWokAAscACAAIAJC////////////AIM3AwggACABNwMAC5UJAgZ/A34jAEEwayIEJABCACEKAkACQCACQQJLDQAgAkECdCICQdymBGooAgAhBSACQdCmBGooAgAhBgNAAkACQCABKAIEIgIgASgCaEYNACABIAJBAWo2AgQgAi0AACECDAELIAEQjwIhAgsgAhCYAg0AC0EBIQcCQAJAIAJBVWoOAwABAAELQX9BASACQS1GGyEHAkAgASgCBCICIAEoAmhGDQAgASACQQFqNgIEIAItAAAhAgwBCyABEI8CIQILQQAhCAJAAkACQCACQV9xQckARw0AA0AgCEEHRg0CAkACQCABKAIEIgIgASgCaEYNACABIAJBAWo2AgQgAi0AACECDAELIAEQjwIhAgsgCEGDgARqIQkgCEEBaiEIIAJBIHIgCSwAAEYNAAsLAkAgCEEDRg0AIAhBCEYNASADRQ0CIAhBBEkNAiAIQQhGDQELAkAgASkDcCIKQgBTDQAgASABKAIEQX9qNgIECyADRQ0AIAhBBEkNACAKQgBTIQIDQAJAIAINACABIAEoAgRBf2o2AgQLIAhBf2oiCEEDSw0ACwsgBCAHskMAAIB/lBDRAiAEQQhqKQMAIQsgBCkDACEKDAILAkACQAJAAkACQCAIDQBBACEIIAJBX3FBzgBHDQADQCAIQQJGDQICQAJAIAEoAgQiAiABKAJoRg0AIAEgAkEBajYCBCACLQAAIQIMAQsgARCPAiECCyAIQZuMBGohCSAIQQFqIQggAkEgciAJLAAARg0ACwsgCA4EAwEBAAELAkACQCABKAIEIgIgASgCaEYNACABIAJBAWo2AgQgAi0AACECDAELIAEQjwIhAgsCQAJAIAJBKEcNAEEBIQgMAQtCACEKQoCAgICAgOD//wAhCyABKQNwQgBTDQUgASABKAIEQX9qNgIEDAULA0ACQAJAIAEoAgQiAiABKAJoRg0AIAEgAkEBajYCBCACLQAAIQIMAQsgARCPAiECCyACQb9/aiEJAkACQCACQVBqQQpJDQAgCUEaSQ0AIAJBn39qIQkgAkHfAEYNACAJQRpPDQELIAhBAWohCAwBCwtCgICAgICA4P//ACELIAJBKUYNBAJAIAEpA3AiDEIAUw0AIAEgASgCBEF/ajYCBAsCQAJAIANFDQAgCA0B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NAIANwMADwsgAiACKAIAIgFBBGo2AgAgACABNQIANwMADwsgAiACKAIAIgFBBGo2AgAgACABNAIANwMADwsgAiACKAIAIgFBBGo2AgAgACABNQIANwMADwsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKQMANwMADwsgAiACKAIAIgFBBGo2AgAgACABMgEANwMADwsgAiACKAIAIgFBBGo2AgAgACABMwEANwMADwsgAiACKAIAIgFBBGo2AgAgACABMAAANwMADwsgAiACKAIAIgFBBGo2AgAgACABMQAANwMADwsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKQMANwMADwsgAiACKAIAIgFBBGo2AgAgACABNQIANwMADwsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKQMANwMADwsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKQMANwMADwsgAiACKAIAIgFBBGo2AgAgACABNAIANwMADwsgAiACKAIAIgFBBGo2AgAgACABNQIANwMADwsgAiACKAIAQQdqQXhxIgFBCGo2AgAgACABKwMAOQMADwsgACACIAMRBQALCz4BAX8CQCAAUA0AA0AgAUF/aiIBIACnQQ9xQcCqBGotAAAgAnI6AAAgAEIPViEDIABCBIghACADDQALCyABCzYBAX8CQCAAUA0AA0AgAUF/aiIBIACnQQdxQTByOgAAIABCB1YhAiAAQgOIIQAgAg0ACwsgAQuKAQIBfgN/AkACQCAAQoCAgIAQWg0AIAAhAgwBCwNAIAFBf2oiASAAIABCCoAiAkIKfn2nQTByOgAAIABC/////58BViEDIAIhACADDQALCwJAIAJQDQAgAqchAwNAIAFBf2oiASADIANBCm4iBEEKbGtBMHI6AAAgA0EJSyEFIAQhAyAFDQALCyABC28BAX8jAEGAAmsiBSQAAkAgAiADTA0AIARBgMAEcQ0AIAUgASACIANrIgNBgAIgA0GAAkkiAhsQ8wEaAkAgAg0AA0AgACAFQYACEKUCIANBgH5qIgNB/wFLDQALCyAAIAUgAxClAgsgBUGAAmokAAsPACAAIAEgAkE8QT0QowILkxkDEn8DfgF8IwBBsARrIgYkAEEAIQcgBkEANgIsAkACQCABEK8CIhhCf1UNAEEBIQhB84AEIQkgAZoi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AAwDC0EAIQMLIAZFDQACQAJAIAIgAigCHCIFQQJ0QdiyBGoiBCgCAEcNACAEIAM2AgAgAw0BQQBBACgCrLAEQX4gBXdxNgKssAQMAgsgBkEQQRQgBigCECACRhtqIAM2AgAgA0UNAQsgAyAGNgIYAkAgAigCECIERQ0AIAMgBDYCECAEIAM2AhgLIAIoAhQiBEUNACADIAQ2AhQgBCADNgIYCyAAIAFBAXI2AgQgACABaiABNgIAIABBACgCvLAERw0AQQAgATYCsLAEDwsCQCABQf8BSw0AIAFBeHFB0LAEaiEDAkACQEEAKAKosAQiBEEBIAFBA3Z0IgFxDQBBACAEIAFyNgKosAQgAyEBDAELIAMoAgghAQsgAyAANgIIIAEgADYCDCAAIAM2AgwgACABNgIIDwtBHyEDAkAgAUH///8HSw0AIAFBJiABQQh2ZyIDa3ZBAXEgA0EBdGtBPmohAwsgACADNgIcIABCADcCECADQQJ0QdiyBGohBAJAAkACQEEAKAKssAQiBUEBIAN0IgJxDQBBACAFIAJyNgKssAQgBCAANgIAIAAgBDYCGAwBCyABQQBBGSADQQF2ayADQR9GG3QhAyAEKAIAIQUDQCAFIgQoAgRBeHEgAUYNAiADQR12IQUgA0EBdCEDIAQgBUEEcWpBEGoiAigCACIFDQALIAIgADYCACAAIAQ2AhgLIAAgADYCDCAAIAA2AggPCyAEKAIIIgEgADYCDCAEIAA2AgggAEEANgIYIAAgBDYCDCAAIAE2AggLC+oKAgR/BH4jAEHwAGsiBSQAIARC////////////AIMhCQJAAkACQCABUCIGIAJC////////////AIMiCkKAgICAgIDAgIB/fEKAgICAgIDAgIB/VCAKUBsNACADQgBSIAlCgICAgICAwICAf3wiC0KAgICAgIDAgIB/ViALQoCAgICAgMCAgH9RGw0BCwJAIAYgCkKAgICAgIDA//8AVCAKQoCAgICAgMD//wBRGw0AIAJCgICAgICAIIQhBCABIQMMAgsCQCADUCAJQoCAgICAgMD//wBUIAlCgICAgICAwP//AFEbDQAgBEKAgICAgIAghCEEDAILAkAgASAKQoCAgICAgMD//wCFhEIAUg0AQoCAgICAgOD//wAgAiADIAGFIAQgAoVCgICAgICAgICAf4WEUCIGGyEEQgAgASAGGyEDDAILIAMgCUKAgICAgIDA//8AhYRQDQECQCABIAqEQgBSDQAgAyAJhEIAUg0CIAMgAYMhAyAEIAKDIQQMAgsgAyAJhFBFDQAgASEDIAIhBAwBCyADIAEgAyABViAJIApWIAkgClEbIgcbIQkgBCACIAcbIgtC////////P4MhCiACIAQgBxsiDEIwiKdB//8BcSEIAkAgC0IwiKdB//8BcSIGDQAgBUHgAGogCSAKIAkgCiAKUCIGG3kgBkEGdK18pyIGQXFqEMwCQRAgBmshBiAFQegAaikDACEKIAUpA2AhCQsgASADIAcbIQMgDEL///////8/gyEBAkAgCA0AIAVB0ABqIAMgASADIAEgAVAiBxt5IAdBBnStfKciB0FxahDMAkEQIAdrIQggBUHYAGopAwAhASAFKQNQIQMLIAFCA4YgA0I9iIRCgICAgICAgASEIQEgCkIDhiAJQj2IhCEMIANCA4YhCiAEIAKFIQMCQCAGIAhGDQACQCAGIAhrIgdB/wBNDQBCACEBQgEhCgwBCyAFQcAAaiAKIAFBgAEgB2sQzAIgBUEwaiAKIAEgBxDWAiAFKQMwIAUpA0AgBUHAAGpBCGopAwCEQgBSrYQhCiAFQTBqQQhqKQMAIQELIAxCgICAgICAgASEIQwgCUIDhiEJAkACQCADQn9VDQBCACEDQgAhBCAJIAqFIAwgAYWEUA0CIAkgCn0hAiAMIAF9IAkgClStfSIEQv////////8DVg0BIAVBIGogAiAEIAIgBCAEUCIHG3kgB0EGdK18p0F0aiIHEMwCIAYgB2shBiAFQShqKQMAIQQgBSkDICECDAELIAEgDHwgCiAJfCICIApUrXwiBEKAgICAgICACINQDQAgAkIBiCAEQj+GhCAKQgGDhCECIAZBAWohBiAEQgGIIQQLIAtCgICAgICAgICAf4MhCgJAIAZB//8BSA0AIApCgICAgICAwP//AIQhBEIAIQMMAQtBACEHAkACQCAGQQBMDQAgBiEHDAELIAVBEGogAiAEIAZB/wBqEMwCIAUgAiAEQQEgBmsQ1gIgBSkDACAFKQMQIAVBEGpBCGopAwCEQgBSrYQhAiAFQQhqKQMAIQQLIAJCA4ggBEI9hoQhAyAHrUIwhiAEQgOIQv///////z+DhCAKhCEEIAKnQQdxIQYCQAJAAkACQAJAENQCDgMAAQIDCwJAIAZBBEYNACAEIAMgBkEES618IgogA1StfCEEIAohAwwDCyAEIAMgA0IBg3wiCiADVK18IQQgCiEDDAMLIAQgAyAKQgBSIAZBAEdxrXwiCiADVK18IQQgCiEDDAELIAQgAyAKUCAGQQBHca18IgogA1StfCEEIAohAwsgBkUNAQsQ1QIaCyAAIAM3AwAgACAENwMIIAVB8ABqJAALUwEBfgJAAkAgA0HAAHFFDQAgASADQUBqrYYhAkIAIQEMAQsgA0UNACABQcAAIANrrYggAiADrSIEhoQhAiABIASGIQELIAAgATcDACAAIAI3AwgL5gECAX8CfkEBIQQCQCAAQgBSIAFC////////////AIMiBUKAgICAgIDA//8AViAFQoCAgICAgMD//wBRGw0AIAJCAFIgA0L///////////8AgyIGQoCAgICAgMD//wBWIAZCgICAgICAwP//AFEbDQACQCACIACEIAYgBYSEUEUNAEEADwsCQCADIAGDQgBTDQACQCAAIAJUIAEgA1MgASADURtFDQBBfw8LIAAgAoUgASADhYRCAFIPCwJAIAAgAlYgASADVSABIANRG0UNAEF/DwsgACAChSABIAOFhEIAUiEECyAEC9gBAgF/An5BfyEEAkAgAEIAUiABQv///////////wCDIgVCgICAgICAwP//AFYgBUKAgICAgIDA//8AURsNACACQgBSIANC////////////AIMiBkKAgICAgIDA//8AViAGQoCAgICAgMD//wBRGw0AAkAgAiAAhCAGIAWEhFBFDQBBAA8LAkAgAyABg0IAUw0AIAAgAlQgASADUyABIANRGw0BIAAgAoUgASADhYRCAFIPCyAAIAJWIAEgA1UgASADURsNACAAIAKFIAEgA4WEQgBSIQQLIAQL5xACBX8PfiMAQdACayIFJAAgBEL///////8/gyEKIAJC////////P4MhCyAEIAKFQoCAgICAgICAgH+DIQwgBEIwiKdB//8BcSEGAkACQAJAIAJCMIinQf//AXEiB0GBgH5qQYKAfkkNAEEAIQggBkGBgH5qQYGAfksNAQsCQCABUCACQv///////////wCDIg1CgICAgICAwP//AFQgDUKAgICAgIDA//8AURsNACACQoCAgICAgCCEIQwM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rXwiASAOViABIA5RG618IgMgAlStfCICIAMgAkKAgICAgIDA//8AVCAEIAUpAxBWIAEgBUEQakEIaikDACICViABIAJRG3GtfCICIANUrXwiAyACIANCgICAgICAwP//AFQgBCAFKQMAViABIAVBCGopAwAiBFYgASAEURtxrXwiASACVK18IAyEIQwLIAAgATcDACAAIAw3AwggBUHQAmokAAv6AQICfwR+IwBBEGsiAiQAIAG9IgRC/////////weDIQUCQAJAIARCNIhC/w+DIgZQDQACQCAGQv8PUQ0AIAVCBIghByAFQjyGIQUgBkKA+AB8IQYMAgsgBUIEiCEHIAVCPIYhBUL//wEhBgwBCwJAIAVQRQ0AQgAhBUIAIQdCACEGDAELIAIgBUIAIASnZ0EgaiAFQiCIp2cgBUKAgICAEFQbIgNBMWoQzAJBjPgAIANrrSEGIAJBCGopAwBCgICAgICAwACFIQcgAikDACEFCyAAIAU3AwAgACAGQjCGIARCgICAgICAgICAf4OEIAeENwMIIAJBEGokAAveAQIFfwJ+IwBBEGsiAiQAIAG8IgNB////A3EhBAJAAkAgA0EXdiIFQf8BcSIGRQ0AAkAgBkH/AUYNACAErUIZhiEHIAVB/wFxQYD/AGohBEIAIQgMAgsgBK1CGYYhB0IAIQhB//8BIQQMAQsCQCAEDQBCACEIQQAhBEIAIQcMAQsgAiAErUIAIARnIgRB0QBqEMwCQYn/ACAEayEEIAJBCGopAwBCgICAgICAwACFIQcgAikDACEICyAAIAg3AwAgACAErUIwhiADQR92rUI/hoQgB4Q3AwggAkEQaiQAC40BAgJ/An4jAEEQayICJAACQAJAIAENAEIAIQRCACEFDAELIAIgASABQR91IgNzIANrIgOtQgAgA2ciA0HRAGoQzAIgAkEIaikDAEKAgICAgIDAAIVBnoABIANrrUIwhnwgAUGAgICAeHGtQiCGhCEFIAIpAwAhBAsgACAENwMAIAAgBTcDCCACQRBqJAALdQIBfwJ+IwBBEGsiAiQAAkACQCABDQBCACEDQgAhBAwBCyACIAGtQgBB8AAgAWciAUEfc2sQzAIgAkEIaikDAEKAgICAgIDAAIVBnoABIAFrrUIwhnwhBCACKQMAIQMLIAAgAzcDACAAIAQ3AwggAkEQaiQACwQAQQALBABBAAtTAQF+AkACQCADQcAAcUUNACACIANBQGqtiCEBQgAhAgwBCyADRQ0AIAJBwAAgA2uthiABIAOtIgSIhCEBIAIgBIghAgsgACABNwMAIAAgAjcDCAuaCwIFfw9+IwBB4ABrIgUkACAEQv///////z+DIQogBCAChUKAgICAgICAgIB/gyELIAJC////////P4MiDEIgiCENIARCMIinQf//AXEhBgJAAkACQCACQjCIp0H//wFxIgdBgYB+akGCgH5JDQBBACEIIAZBgYB+akGBgH5LDQELAkAgAVAgAkL///////////8AgyIOQoCAgICAgMD//wBUIA5CgICAgICAwP//AFEbDQAgAkKAgICAgIAghCELDAILAkAgA1AgBEL///////////8AgyICQoCAgICAgMD//wBUIAJCgICAgICAwP//AFEbDQAgBEKAgICAgIAghCELIAMhAQwCCwJAIAEgDkKAgICAgIDA//8AhYRCAFINAAJAIAMgAoRQRQ0AQoCAgICAgOD//wAhC0IAIQEMAwsgC0KAgICAgIDA//8AhCELQgAhAQwCCwJAIAMgAkKAgICAgIDA//8AhYRCAFINACABIA6EIQJCACEBAkAgAlBFDQBCgICAgICA4P//ACELDAMLIAtCgICAgICAwP//AIQhCwwCCwJAIAEgDoRCAFINAEIAIQEMAgsCQCADIAKEQgBSDQBCACEBDAILQQAhCAJAIA5C////////P1YNACAFQdAAaiABIAwgASAMIAxQIggbeSAIQQZ0rXynIghBcWoQzAJBECAIayEIIAVB2ABqKQMAIgxCIIghDSAFKQNQIQELIAJC////////P1YNACAFQcAAaiADIAogAyAKIApQIgkbeSAJQQZ0rXynIglBcWoQzAIgCCAJa0EQaiEIIAVByABqKQMAIQogBSkDQCEDCyADQg+GIg5CgID+/w+DIgIgAUIgiCIEfiIPIA5CIIgiDiABQv////8PgyIBfnwiEEIghiIRIAIgAX58IhIgEVStIAIgDEL/////D4MiDH4iEyAOIAR+fCIRIANCMYggCkIPhiIUhEL/////D4MiAyABfnwiFSAQQiCIIBAgD1StQiCGhHwiECACIA1CgIAEhCIKfiIWIA4gDH58Ig0gFEIgiEKAgICACIQiAiABfnwiDyADIAR+fCIUQiCGfCIXfCEBIAcgBmogCGpBgYB/aiEGAkACQCACIAR+IhggDiAKfnwiBCAYVK0gBCADIAx+fCIOIARUrXwgAiAKfnwgDiARIBNUrSAVIBFUrXx8IgQgDlStfCADIAp+IgMgAiAMfnwiAiADVK1CIIYgAkIgiIR8IAQgAkIghnwiAiAEVK18IAIgFEIgiCANIBZUrSAPIA1UrXwgFCAPVK18QiCGhHwiBCACVK18IAQgECAVVK0gFyAQVK18fCICIARUrXwiBEKAgICAgIDAAINQDQAgBkEBaiEGDAELIBJCP4ghAyAEQgGGIAJCP4iEIQQgAkIBhiABQj+IhCECIBJCAYYhEiADIAFCAYaEIQELAkAgBkH//wFIDQAgC0KAgICAgIDA//8AhCELQgAhAQwBCwJAAkAgBkEASg0AAkBBASAGayIHQf8ASw0AIAVBMGogEiABIAZB/wBqIgYQzAIgBUEgaiACIAQgBhDMAiAFQRBqIBIgASAHENYCIAUgAiAEIAcQ1gIgBSkDICAFKQMQhCAFKQMwIAVBMGpBCGopAwCEQgBSrYQhEiAFQSBqQQhqKQMAIAVBEGpBCGopAwCEIQEgBUEIaikDACEEIAUpAwAhAgwCC0IAIQEMAgsgBq1CMIYgBEL///////8/g4QhBAsgBCALhCELAkAgElAgAUJ/VSABQoCAgICAgICAgH9RGw0AIAsgAkIBfCIBUK18IQsMAQsCQCASIAFCgICAgICAgICAf4WEQgBRDQAgAiEBDAELIAsgAiACQgGDfCIBIAJUrXwhCwsgACABNwMAIAAgCzcDCCAFQeAAaiQAC3UBAX4gACAEIAF+IAIgA358IANCIIgiAiABQiCIIgR+fCADQv////8PgyIDIAFC/////w+DIgF+IgVCIIggAyAEfnwiA0IgiHwgA0L/////D4MgAiABfnwiAUIgiHw3AwggACABQiCGIAVC/////w+DhDcDAAtIAQF/IwBBEGsiBSQAIAUgASACIAMgBEKAgICAgICAgIB/hRDLAiAFKQMAIQQgACAFQQhqKQMANwMIIAAgBDcDACAFQRBqJAALkAQCBX8CfiMAQSBrIgIkACABQv///////z+DIQcCQAJAIAFCMIhC//8BgyIIpyIDQf+Hf2pB/Q9LDQAgAEI8iCAHQgSGhCEHIANBgIh/aq0hCAJAAkAgAEL//////////w+DIgBCgYCAgICAgIAIVA0AIAdCAXwhBwwBCyAAQoCAgICAgICACFINACAHQgGDIAd8IQcLQgAgByAHQv////////8HViIDGyEAIAOtIAh8IQcMAQsCQCAAIAeEUA0AIAhC//8BUg0AIABCPIggB0IEhoRCgICAgICAgASEIQBC/w8hBwwBCwJAIANB/ocBTQ0AQv8PIQdCACEADAELAkBBgPgAQYH4ACAIUCIEGyIFIANrIgZB8ABMDQBCACEAQgAhBwwBCyACQRBqIAAgByAHQoCAgICAgMAAhCAEGyIHQYABIAZrEMwCIAIgACAHIAYQ1gIgAikDACIHQjyIIAJBCGopAwBCBIaEIQACQAJAIAdC//////////8PgyAFIANHIAIpAxAgAkEQakEIaikDAIRCAFJxrYQiB0KBgICAgICAgAhUDQAgAEIBfCEADAELIAdCgICAgICAgIAIUg0AIABCAYMgAHwhAAsgAEKAgICAgICACIUgACAAQv////////8HViIDGyEAIAOtIQcLIAJBIGokACAHQjSGIAFCgICAgICAgICAf4OEIACEvwvxAwIFfwJ+IwBBIGsiAiQAIAFC////////P4MhBwJAAkAgAUIwiEL//wGDIginIgNB/4B/akH9AUsNACAHQhmIpyEEAkACQCAAUCABQv///w+DIgdCgICACFQgB0KAgIAIURsNACAEQQFqIQQMAQsgACAHQoCAgAiFhEIAUg0AIARBAXEgBGohBAtBACAEIARB////A0siBRshBEGBgX9BgIF/IAUbIANqIQMMAQsCQCAAIAeEUA0AIAhC//8BUg0AIAdCGYinQYCAgAJyIQRB/wEhAwwBCwJAIANB/oABTQ0AQf8BIQNBACEEDAELAkBBgP8AQYH/ACAIUCIFGyIGIANrIgRB8ABMDQBBACEEQQAhAwwBCyACQRBqIAAgByAHQoCAgICAgMAAhCAFGyIHQYABIARrEMwCIAIgACAHIAQQ1gIgAkEIaikDACIAQhmIpyEEAkACQCACKQMAIAYgA0cgAikDECACQRBqQQhqKQMAhEIAUnGthCIHUCAAQv///w+DIgBCgICACFQgAEKAgIAIURsNACAEQQFqIQQMAQsgByAAQoCAgAiFhEIAUg0AIARBAXEgBGohBAsgBEGAgIAEcyAEIARB////A0siAxshBAsgAkEgaiQAIANBF3QgAUIgiKdBgICAgHhxciAEcr4LEgBBgIAEJAJBAEEPakFwcSQBCwcAIwAjAWsLBAAjAgsEACMBCwYAIAAkAAsSAQJ/IwAgAGtBcHEiASQAIAELBAAjAAvDAgEDfwJAIAANAEEAIQECQEEAKALUrgRFDQBBACgC1K4EEOMCIQELAkBBACgC1K4ERQ0AQQAoAtSuBBDjAiABciEBCwJAEP4BKAIAIgBFDQADQEEAIQICQCAAKAJMQQBIDQAgABD0ASECCwJAIAAoAhQgACgCHEYNACAAEOMCIAFyIQELAkAgAkUNACAAEPUBCyAAKAI4IgANAAsLEP8BIAEPCwJAAkAgACgCTEEATg0AQQEhAgwBCyAAEPQBRSECCwJAAkACQCAAKAIUIAAoAhxGDQAgAEEAQQAgACgCJBEDABogACgCFA0AQX8hASACRQ0BDAILAkAgACgCBCIBIAAoAggiA0YNACAAIAEgA2usQQEgACgCKBEtABoLQQAhASAAQQA2AhwgAEIANwMQIABCADcCBCACDQELIAAQ9QELIAELC8AuAgBBgIAEC6wuegBpbmZpbml0eQBvdXQgb2YgbWVtb3J5AFNhdmVkIGRhdGEgZW5kZWQgdW5leHBlY3RlZGx5AG1pZGVuZF9yZWFsbHlfcHJvY2Vzc19rZXkAIyUwMnglMDJ4JTAyeAAlMnglMnglMngALSsgICAwWDB4AC0wWCswWCAwWC0weCsweCAweABoaW50X3JlZHJhdwBndWVzc19yZWRyYXcAbWlkZW5kX3JlZHJhdwAhbWUtPm91cmdhbWUtPnByZXNldF9tZW51AFN1Ym1pdABBcnJvd1JpZ2h0AEFycm93TGVmdABTb2Z0TGVmdABDYW5ub3QgaGFuZGxlIHRoaXMgdmVyc2lvbiBvZiB0aGUgc2F2ZWQgZ2FtZSBmaWxlIGZvcm1hdABvbmUta2V5LXNob3J0Y3V0cwBpIDwgbnByZXNldHMAbWlkZW5kX2dldF9wcmVzZXRzAGdhbWVzLmd1ZXNzAFBlZ3MgcGVyIGd1ZXNzAE11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgZ3Vlc3MAR3Vlc3MAYyA8PSBwYXJhbXMtPm5jb2xvdXJzAG1pZGVuZF9jb2xvdXJzAFRvbyBtYW55IGNvbG91cnMAQ29sb3VycwBMYWJlbCBjb2xvdXJzIHdpdGggbnVtYmVycwBlbmNvZGVfcGFyYW1zAFVuZG9pbmcgdGhpcyBuZXctZ2FtZSBvcGVyYXRpb24gd291bGQgY2hhbmdlIHBhcmFtcwBzaG93LWxhYmVscwBBbGxvdyBibGFua3MAc3JjLT5ucGVncyA9PSBkZXN0LT5ucGVncwAobmNfY29sb3VyICsgbmNfcGxhY2UpIDw9IGd1ZXNzLT5ucGVncwBvdmVyX2NvbCA+PSAxICYmIG92ZXJfY29sIDw9IGRzLT5jb2xvdXJzLT5ucGVncwBwIC0gcmV0IDwgNDAgKiB1aS0+Y3Vycl9wZWdzLT5ucGVncwBvdmVyX3Bhc3RfZ3Vlc3NfeCA+PSAwICYmIG92ZXJfcGFzdF9ndWVzc194IDwgZHMtPnNvbHV0aW9uLT5ucGVncwBvdmVyX2d1ZXNzID49IDAgJiYgb3Zlcl9ndWVzcyA8IGRzLT5zb2x1dGlvbi0+bnBlZ3MAbWFya19wZWdzAERpc2FsbG93aW5nIG11bHRpcGxlIGNvbG91cnMgcmVxdWlyZXMgYXQgbGVhc3QgYXMgbWFueSBjb2xvdXJzIGFzIHBlZ3MAbWlkZW5kX2FwcGx5X3ByZWZzAG1pZGVuZF9nZXRfcHJlZnMAc2F2ZV9wcmVmcwBtaWRlbmRfc2VyaWFsaXNlX3ByZWZzAHBvcyA8IG5fbWVfcHJlZnMAbWUtPnN0YXRlcG9zID49IDEgJiYgbWUtPnN0YXRlcG9zIDw9IG1lLT5uc3RhdGVzAGdvdHN0YXRlcyA8IGRhdGEubnN0YXRlcwBBbGxvdyBkdXBsaWNhdGVzAEd1ZXNzZXMAJXMgcHJlZmVyZW5jZXMAYyVkcCVkZyVkJXMlcwAlcyVkJXMAJXMlYyVzACVzOiVzACVzIyVzAHBhcnN0cgAhZGVzZXJpYWxpc2VfZXJyb3IARW50ZXIAU3VwZXIAU3BhY2ViYXIAc3RhdHVzX2JhcgBBcnJvd1VwAFBhZ2VVcAByYW5kb21fdXB0bwBvdmVyX3Bhc3RfZ3Vlc3NfeSA+PSAwICYmIG92ZXJfcGFzdF9ndWVzc195IDwgZnJvbS0+bmV4dF9nbwBtaWRlbmRfdW5kbwBtaWRlbmRfcmVkbwBBcnJvd0Rvd24AUGFnZURvd24AU2ltb24gVGF0aGFtJ3MgUG9ydGFibGUgUHV6emxlIENvbGxlY3Rpb24AJXMgJXMgc2VsZWN0aW9uACVzIGNvbmZpZ3VyYXRpb24AVGhpcyBnYW1lIGRvZXMgbm90IHN1cHBvcnQgdGhlIFNvbHZlIG9wZXJhdGlvbgBJbnZhbGlkIHZhbHVlIGZvciBlbnVtZXJhdGlvbgBoZXgyYmluAGxlbiA8IElOVF9NQVggLSBzZXItPmxlbgBwIC0gYnVmIDw9IGxlbgBuYW4AcmFuZG9tAEtleWJvYXJkIHNob3J0Y3V0cyB3aXRob3V0IEN0cmwAbWlkZW5kX2N1cnJlbnRfa2V5X2xhYmVsAERlbABkbGdfcmV0dXJuX3N2YWwAZGxnX3JldHVybl9pdmFsAG1pZGVuZF9kZXNlcmlhbGlzZV9pbnRlcm5hbABlbmNvZGVfdWkAYXNzZXJ0X3ByaW50YWJsZV9hc2NpaQBHYW1lIGRlc2NyaXB0aW9uIGlzIHdyb25nIGxlbmd0aABtb3Zlc3RyICYmICFtc2cAbWUtPmRyYXdpbmcAVHJpdmlhbCBzb2x1dGlvbnMgYXJlIHVuaW50ZXJlc3RpbmcAR2FtZSBkZXNjcmlwdGlvbiBpbiBzYXZlIGZpbGUgaXMgbWlzc2luZwBTaG9ydC10ZXJtIHBhcmFtZXRlcnMgaW4gc2F2ZSBmaWxlIGFyZSBtaXNzaW5nAExvbmctdGVybSBwYXJhbWV0ZXJzIGluIHNhdmUgZmlsZSBhcmUgbWlzc2luZwBtaWRlbmRfZ2V0X2NvbmZpZwBjZmcAIWRzLT5ibGl0X3BlZwAlZwBpbmYAMDEyMzQ1Njc4OWFiY2RlZgBnYW1lX3NldF9zaXplAG5ld19zaXplID4gYnVmLT5zaXplAGJ1Zi0+bGVuIDwgYnVmLT5zaXplAGN0eC5wb3MgPT0gc2l6ZQBpbnRlcnByZXRfbW92ZQBlbmNvZGVfbW92ZQBTYXZlIGZpbGUgY29udGFpbmVkIGFuIGludmFsaWQgcmVzdGFydCBtb3ZlAFNhdmUgZmlsZSBjb250YWluZWQgYW4gaW52YWxpZCBtb3ZlAG1pZGVuZF9zb2x2ZQBObyBnYW1lIHNldCB1cCB0byBzb2x2ZQBOdW1iZXIgb2Ygc3RhdGVzIGluIHNhdmUgZmlsZSB3YXMgbmVnYXRpdmUAdHJ1ZQBtaWRlbmRfc2VyaWFsaXNlX2J1Zl93cml0ZQBEZWxldGUAZmFsc2UAbWlkZW5kX3NlcmlhbGlzZQBFc2NhcGUASG9tZQBtaWRlbmRfbmV3X2dhbWUAbWlkZW5kX3Jlc3RhcnRfZ2FtZQBTYXZlIGZpbGUgaXMgZnJvbSBhIGRpZmZlcmVudCBnYW1lAGRyaS0+bWUAd2ludGl0bGUAZ2V0X3NhdmVfZmlsZQBQYXJ0aWFsIGxpbmUgYXQgZW5kIG9mIHByZWZlcmVuY2VzIGZpbGUATm8gc3RhdGUgY291bnQgcHJvdmlkZWQgaW4gc2F2ZSBmaWxlAFR3byBzdGF0ZSBjb3VudHMgcHJvdmlkZWQgaW4gc2F2ZSBmaWxlAE5vIGdhbWUgcG9zaXRpb24gcHJvdmlkZWQgaW4gc2F2ZSBmaWxlAEZvcmJpZGRlbiBjaGFyYWN0ZXJzIGluIHNhdmVkIGdhbWUgZmlsZQBEYXRhIHdhcyBpbmNvcnJlY3RseSBmb3JtYXR0ZWQgZm9yIGEgc2F2ZWQgZ2FtZSBmaWxlAERhdGEgZG9lcyBub3QgYXBwZWFyIHRvIGJlIGEgc2F2ZWQgZ2FtZSBmaWxlAGlzX21hcmthYmxlAGFsbG9jYXRpb24gdG9vIGxhcmdlAEdhbWUgcG9zaXRpb24gaW4gc2F2ZSBmaWxlIGlzIG91dCBvZiByYW5nZQBCYWNrc3BhY2UAUGxhY2UARXhwZWN0ZWQgJz0nIGFmdGVyIGtleXdvcmQAU3RhbmRhcmQAYnVmZmVyX2FwcGVuZABjb21tYW5kAEVuZABIb2xkAEdhbWUgcHJpdmF0ZSBkZXNjcmlwdGlvbiBpbiBzYXZlIGZpbGUgaXMgaW52YWxpZABHYW1lIGRlc2NyaXB0aW9uIGluIHNhdmUgZmlsZSBpcyBpbnZhbGlkAFNob3J0LXRlcm0gcGFyYW1ldGVycyBpbiBzYXZlIGZpbGUgYXJlIGludmFsaWQATG9uZy10ZXJtIHBhcmFtZXRlcnMgaW4gc2F2ZSBmaWxlIGFyZSBpbnZhbGlkAG1pZGVuZF9nZXRfZ2FtZV9pZABHYW1lIGRlc2NyaXB0aW9uIGlzIGNvcnJ1cHRlZABTb2x2ZSBvcGVyYXRpb24gZmFpbGVkAGNvcHlfbGVmdF9qdXN0aWZpZWQAbWlkZW5kX2dldF9yYW5kb21fc2VlZABHYW1lIHJhbmRvbSBzZWVkACVzX0NPTE9VUl8lZABtZS0+ZGVzYwAvcHV6emxlcy9ndWVzcy5jAC9wdXp6bGVzL3JhbmRvbS5jAC9wdXp6bGVzL2RyYXdpbmcuYwAvcHV6emxlcy9taWRlbmQuYwAvcHV6emxlcy9taXNjLmMAL3B1enpsZXMvZW1jYy5jAGIAXwBaAHlZdFQAUkVTVEFSVAAlc19ERUZBVUxUACVzX1BSRVNFVFMAU1RBVEVQT1MAQ1BBUkFNUwBOU1RBVEVTAFBVWlpMRVNfU0hPV19DVVJTT1IAQVVYSU5GTwBWRVJTSU9OAE5BTgBQVVpaTEVTX0FMTE9XX0NVU1RPTQBzICE9IE5VTEwAbW92ZXN0ciAhPSBOVUxMAFVJAElORgAwLjBGIDw9IHJldFtpKjMgKyAyXSAmJiByZXRbaSozICsgMl0gPD0gMS4wRgAwLjBGIDw9IHJldFtpKjMgKyAxXSAmJiByZXRbaSozICsgMV0gPD0gMS4wRgAwLjBGIDw9IHJldFtpKjMgKyAwXSAmJiByZXRbaSozICsgMF0gPD0gMS4wRgAlc19USUxFU0laRQBNT1ZFAFNPTFZFAG1vdmVzdHIgIT0gTU9WRV9VSV9VUERBVEUAVElNRQBtZS0+c3RhdGVzW2ldLm1vdmV0eXBlICE9IE5FV0dBTUUAZGF0YS5zdGF0ZXNbaV0ubW92ZXR5cGUgIT0gTkVXR0FNRQBTQVZFRklMRQBHYW1lIElEAEhFWFNFRUQAUFJJVkRFU0MAQgA9ACVzOiVkOgBsZW4gPD0gOABzW2ldID49IDMyICYmIHNbaV0gPCAxMjcAYml0cyA8IDMyACpuY29sb3VycyA+PSAxAG1lLT5zdGF0ZXBvcyA+PSAxAGxlbiA8PSBzeiAtIDEAZHMtPnBlZ3N6ID4gMABtZS0+bnN0YXRlcyA9PSAwAG1lLT5kaXIgIT0gMABjICE9IDAAQ3VzdG9tLi4uAGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6LQAsAGd1ZXNzICYmIHNvbHV0aW9uICYmIChndWVzcy0+bnBlZ3MgPT0gc29sdXRpb24tPm5wZWdzKQBJU19DVVJTT1JfU0VMRUNUKGJ1dHRvbikAKG51bGwpAFZhbHVlIGZvciBib29sZWFuIHdhcyBub3QgJ3RydWUnIG9yICdmYWxzZScAZW5jb2RlZFtpXSA+PSAzMiAmJiBlbmNvZGVkW2ldIDwgMTI3ICYmIGVuY29kZWRbaV0gIT0gJyMnICYmIGVuY29kZWRbaV0gIT0gJzonAGl0LT5rd1tzdHJzcG4oaXQtPmt3LCAiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXotIildID09ICdcMCcAIwAhZXJyICYmICJCYWQgaW50ZXJuYWwgc2VyaWFsaXNhdGlvbiBvZiBwcmVmZXJlbmNlcyIAMCAmJiAiQmFkIHR5cGUgZm9yIHJldHVybl9zdmFsIgAwICYmICJCYWQgdHlwZSBmb3IgcmV0dXJuX2l2YWwiACEiV2Ugc2hvdWxkbid0IGJlIGhlcmUiAHEgIT0gTlVMTCAmJiAiVmFsdWUgb3V0IG9mIHJhbmdlIGluIENfQ0hPSUNFUyIAWyVkOiUwMmRdIABwdXp6bGUgZmF0YWwgZXJyb3I6IABEcmF3aW5nIEFQSSB2ZXJzaW9uIG1pc21hdGNoOiBleHBlY3RlZDogJWQsIGFjdHVhbDogJWQKAI8BAQBXAQEAiQEBAAEAAAACAAAAAAAAAAMAAAAEAAAABQAAAAYAAAABAAAABwAAAAgAAAAJAAAACgAAAAsAAAAMAAAAAAAAAA0AAAAOAAAAAQAAAA8AAAAAAAAAAAAAAAAAAAAQAAAAEQAAABIAAAATAAAAFAAAABUAAAAAAAAAFgAAABcAAAAYAAAAGQAAACAAAAAaAAAAGwAAABwAAAAdAAAAHgAAAB8AAAAgAAAAIQAAACIAAAAjAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMQsBAAYAAAAEAAAACgAAAAABAAC2BAEACAAAAAUAAAAMAAAAAAEAAAEAAAArAAAALAAAAC0AAAAuAAAALwAAADAAAAAxAAAAMgAAADMAAAA0AAAANQAAADYAAAA3AAAAOAAAADkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADoAAAA7AAAA0XSeAFedvSqAcFIP//8+JwoAAABkAAAA6AMAABAnAACghgEAQEIPAICWmAAA4fUFGAAAADUAAABxAAAAa////877//+Sv///AAAAAAAAAAAZAAsAGRkZAAAAAAUAAAAAAAAJAAAAAAsAAAAAAAAAABkACgoZGRkDCgcAAQAJCxgAAAkGCwAACwAGGQAAABkZGQAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAZAAsNGRkZAA0AAAIACQ4AAAAJAA4AAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAEwAAAAATAAAAAAkMAAAAAAAMAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA8AAAAEDwAAAAAJEAAAAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASAAAAAAAAAAAAAAARAAAAABEAAAAACRIAAAAAABIAABIAABoAAAAaGhoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAAABoaGgAAAAAAAAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAAAAAAAAAAAABcAAAAAFwAAAAAJFAAAAAAAFAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAAAAAAAAAAAAAAVAAAAABUAAAAACRYAAAAAABYAABYAADAxMjM0NTY3ODlBQkNERUb/////////////////////////////////////////////////////////////////AAECAwQFBgcICf////////8KCwwNDg8QERITFBUWFxgZGhscHR4fICEiI////////woLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIj/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////wABAgQHAwYFAAAAAAAAAAIAAMADAADABAAAwAUAAMAGAADABwAAwAgAAMAJAADACgAAwAsAAMAMAADADQAAwA4AAMAPAADAEAAAwBEAAMASAADAEwAAwBQAAMAVAADAFgAAwBcAAMAYAADAGQAAwBoAAMAbAADAHAAAwB0AAMAeAADAHwAAwAAAALMBAADDAgAAwwMAAMMEAADDBQAAwwYAAMMHAADDCAAAwwkAAMMKAADDCwAAwwwAAMMNAADTDgAAww8AAMMAAAy7AQAMwwIADMMDAAzDBAAM2wBBrK4ECwQgGgEAAD8PdGFyZ2V0X2ZlYXR1cmVzAysPbXV0YWJsZS1nbG9iYWxzKw9yZWZlcmVuY2UtdHlwZXMrCm11bHRpdmFsdWU='), c => c.charCodeAt(0));
if (Module['wasmBinary']) wasmBinary = Module['wasmBinary'];
legacyModuleProp('wasmBinary', 'wasmBinary');
if (typeof WebAssembly != 'object') {
  err('no native wasm support detected');
}

// Wasm globals

var wasmMemory;

//========================================
// Runtime essentials
//========================================

// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

// In STRICT mode, we only define assert() when ASSERTIONS is set.  i.e. we
// don't define it at all in release modes.  This matches the behaviour of
// MINIMAL_RUNTIME.
// TODO(sbc): Make this the default even without STRICT enabled.
/** @type {function(*, string=)} */
function assert(condition, text) {
  if (!condition) {
    abort('Assertion failed' + (text ? ': ' + text : ''));
  }
}

// We used to include malloc/free by default in the past. Show a helpful error in
// builds with assertions.

// Memory management

var HEAP, /** @type {!Int8Array} */
  HEAP8, /** @type {!Uint8Array} */
  HEAPU8, /** @type {!Int16Array} */
  HEAP16, /** @type {!Uint16Array} */
  HEAPU16, /** @type {!Int32Array} */
  HEAP32, /** @type {!Uint32Array} */
  HEAPU32, /** @type {!Float32Array} */
  HEAPF32,
  /* BigInt64Array type is not correctly defined in closure
  /** not-@type {!BigInt64Array} */
  HEAP64,
  /* BigUInt64Array type is not correctly defined in closure
  /** not-t@type {!BigUint64Array} */
  HEAPU64, /** @type {!Float64Array} */
  HEAPF64;

// include: runtime_shared.js
function updateMemoryViews() {
  var b = wasmMemory.buffer;
  Module['HEAP8'] = HEAP8 = new Int8Array(b);
  Module['HEAP16'] = HEAP16 = new Int16Array(b);
  Module['HEAPU8'] = HEAPU8 = new Uint8Array(b);
  Module['HEAPU16'] = HEAPU16 = new Uint16Array(b);
  Module['HEAP32'] = HEAP32 = new Int32Array(b);
  Module['HEAPU32'] = HEAPU32 = new Uint32Array(b);
  Module['HEAPF32'] = HEAPF32 = new Float32Array(b);
  Module['HEAPF64'] = HEAPF64 = new Float64Array(b);
  Module['HEAP64'] = HEAP64 = new BigInt64Array(b);
  Module['HEAPU64'] = HEAPU64 = new BigUint64Array(b);
}
// end include: runtime_shared.js
assert(!Module['STACK_SIZE'], 'STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time');
assert(typeof Int32Array != 'undefined' && typeof Float64Array !== 'undefined' && Int32Array.prototype.subarray != undefined && Int32Array.prototype.set != undefined, 'JS engine does not provide full typed array support');

// If memory is defined in wasm, the user can't provide it, or set INITIAL_MEMORY
assert(!Module['wasmMemory'], 'Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally');
assert(!Module['INITIAL_MEMORY'], 'Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically');

// include: runtime_stack_check.js
// Initializes the stack cookie. Called at the startup of main and at the startup of each thread in pthreads mode.
function writeStackCookie() {
  var max = _emscripten_stack_get_end();
  assert((max & 3) == 0);
  // If the stack ends at address zero we write our cookies 4 bytes into the
  // stack.  This prevents interference with SAFE_HEAP and ASAN which also
  // monitor writes to address zero.
  if (max == 0) {
    max += 4;
  }
  // The stack grow downwards towards _emscripten_stack_get_end.
  // We write cookies to the final two words in the stack and detect if they are
  // ever overwritten.
  HEAPU32[max >> 2] = 0x02135467;
  HEAPU32[max + 4 >> 2] = 0x89BACDFE;
  // Also test the global address 0 for integrity.
  HEAPU32[0 >> 2] = 1668509029;
}
function checkStackCookie() {
  if (ABORT) return;
  var max = _emscripten_stack_get_end();
  // See writeStackCookie().
  if (max == 0) {
    max += 4;
  }
  var cookie1 = HEAPU32[max >> 2];
  var cookie2 = HEAPU32[max + 4 >> 2];
  if (cookie1 != 0x02135467 || cookie2 != 0x89BACDFE) {
    abort(`Stack overflow! Stack cookie has been overwritten at ${ptrToString(max)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${ptrToString(cookie2)} ${ptrToString(cookie1)}`);
  }
  // Also test the global address 0 for integrity.
  if (HEAPU32[0 >> 2] != 0x63736d65 /* 'emsc' */) {
    abort('Runtime error: The application has corrupted its heap memory area (address zero)!');
  }
}
// end include: runtime_stack_check.js
// include: runtime_assertions.js
// Endianness check
(function () {
  var h16 = new Int16Array(1);
  var h8 = new Int8Array(h16.buffer);
  h16[0] = 0x6373;
  if (h8[0] !== 0x73 || h8[1] !== 0x63) throw 'Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)';
})();

// end include: runtime_assertions.js
var __ATPRERUN__ = []; // functions called before the runtime is initialized
var __ATINIT__ = []; // functions called during startup
var __ATMAIN__ = []; // functions called when main() is to be run
var __ATEXIT__ = []; // functions called during shutdown
var __ATPOSTRUN__ = []; // functions called after the main() is called

var runtimeInitialized = false;
function preRun() {
  if (Module['preRun']) {
    if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
    while (Module['preRun'].length) {
      addOnPreRun(Module['preRun'].shift());
    }
  }
  callRuntimeCallbacks(__ATPRERUN__);
}
function initRuntime() {
  assert(!runtimeInitialized);
  runtimeInitialized = true;
  checkStackCookie();
  callRuntimeCallbacks(__ATINIT__);
}
function preMain() {
  checkStackCookie();
  callRuntimeCallbacks(__ATMAIN__);
}
function postRun() {
  checkStackCookie();
  if (Module['postRun']) {
    if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
    while (Module['postRun'].length) {
      addOnPostRun(Module['postRun'].shift());
    }
  }
  callRuntimeCallbacks(__ATPOSTRUN__);
}
function addOnPreRun(cb) {
  __ATPRERUN__.unshift(cb);
}
function addOnInit(cb) {
  __ATINIT__.unshift(cb);
}
function addOnPreMain(cb) {
  __ATMAIN__.unshift(cb);
}
function addOnExit(cb) {}
function addOnPostRun(cb) {
  __ATPOSTRUN__.unshift(cb);
}

// include: runtime_math.js
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/imul

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/fround

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/clz32

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/trunc

assert(Math.imul, 'This browser does not support Math.imul(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.fround, 'This browser does not support Math.fround(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.clz32, 'This browser does not support Math.clz32(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.trunc, 'This browser does not support Math.trunc(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
// end include: runtime_math.js
// A counter of dependencies for calling run(). If we need to
// do asynchronous work before running, increment this and
// decrement it. Incrementing must happen in a place like
// Module.preRun (used by emcc to add file preloading).
// Note that you can add dependencies in preRun, even though
// it happens right before run - run will be postponed until
// the dependencies are met.
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null; // overridden to take different actions when all run dependencies are fulfilled
var runDependencyTracking = {};
function getUniqueRunDependency(id) {
  var orig = id;
  while (1) {
    if (!runDependencyTracking[id]) return id;
    id = orig + Math.random();
  }
}
function addRunDependency(id) {
  var _Module$monitorRunDep, _Module;
  runDependencies++;
  (_Module$monitorRunDep = (_Module = Module)['monitorRunDependencies']) === null || _Module$monitorRunDep === void 0 || _Module$monitorRunDep.call(_Module, runDependencies);
  if (id) {
    assert(!runDependencyTracking[id]);
    runDependencyTracking[id] = 1;
    if (runDependencyWatcher === null && typeof setInterval != 'undefined') {
      // Check for missing dependencies every few seconds
      runDependencyWatcher = setInterval(() => {
        if (ABORT) {
          clearInterval(runDependencyWatcher);
          runDependencyWatcher = null;
          return;
        }
        var shown = false;
        for (var dep in runDependencyTracking) {
          if (!shown) {
            shown = true;
            err('still waiting on run dependencies:');
          }
          err(`dependency: ${dep}`);
        }
        if (shown) {
          err('(end of list)');
        }
      }, 10000);
    }
  } else {
    err('warning: run dependency added without ID');
  }
}
function removeRunDependency(id) {
  var _Module$monitorRunDep2, _Module2;
  runDependencies--;
  (_Module$monitorRunDep2 = (_Module2 = Module)['monitorRunDependencies']) === null || _Module$monitorRunDep2 === void 0 || _Module$monitorRunDep2.call(_Module2, runDependencies);
  if (id) {
    assert(runDependencyTracking[id]);
    delete runDependencyTracking[id];
  } else {
    err('warning: run dependency removed without ID');
  }
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null;
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback(); // can add another dependenciesFulfilled
    }
  }
}

/** @param {string|number=} what */
function abort(what) {
  var _Module$onAbort, _Module3;
  (_Module$onAbort = (_Module3 = Module)['onAbort']) === null || _Module$onAbort === void 0 || _Module$onAbort.call(_Module3, what);
  what = 'Aborted(' + what + ')';
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);
  ABORT = true;
  EXITSTATUS = 1;

  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.

  // Suppress closure compiler warning here. Closure compiler's builtin extern
  // definition for WebAssembly.RuntimeError claims it takes no arguments even
  // though it can.
  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
  /** @suppress {checkTypes} */
  var e = new WebAssembly.RuntimeError(what);

  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

// include: memoryprofiler.js
// end include: memoryprofiler.js
// show errors on likely calls to FS when it was not included
var FS = {
  error() {
    abort('Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with -sFORCE_FILESYSTEM');
  },
  init() {
    FS.error();
  },
  createDataFile() {
    FS.error();
  },
  createPreloadedFile() {
    FS.error();
  },
  createLazyFile() {
    FS.error();
  },
  open() {
    FS.error();
  },
  mkdev() {
    FS.error();
  },
  registerDevice() {
    FS.error();
  },
  analyzePath() {
    FS.error();
  },
  ErrnoError() {
    FS.error();
  }
};
Module['FS_createDataFile'] = FS.createDataFile;
Module['FS_createPreloadedFile'] = FS.createPreloadedFile;

// include: URIUtils.js
// Prefix of data URIs emitted by SINGLE_FILE and related options.
var dataURIPrefix = 'data:application/octet-stream;base64,';

/**
 * Indicates whether filename is a base64 data URI.
 * @noinline
 */
var isDataURI = filename => filename.startsWith(dataURIPrefix);

/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */
var isFileURI = filename => filename.startsWith('file://');
// end include: URIUtils.js
function createExportWrapper(name, nargs) {
  return function () {
    assert(runtimeInitialized, `native function \`${name}\` called before runtime initialization`);
    var f = wasmExports[name];
    assert(f, `exported native function \`${name}\` not found`);
    // Only assert for too many arguments. Too few can be valid since the missing arguments will be zero filled.
    assert(arguments.length <= nargs, `native function \`${name}\` called with ${arguments.length} args but expects ${nargs}`);
    return f(...arguments);
  };
}

// include: runtime_exceptions.js
// end include: runtime_exceptions.js
function findWasmBinary() {
  var f = 'guess.wasm';
  if (!isDataURI(f)) {
    return locateFile(f);
  }
  return f;
}
var wasmBinaryFile;
function getBinarySync(file) {
  if (file == wasmBinaryFile && wasmBinary) {
    return new Uint8Array(wasmBinary);
  }
  if (readBinary) {
    return readBinary(file);
  }
  throw 'both async and sync fetching of the wasm failed';
}
function getBinaryPromise(binaryFile) {
  // If we don't have the binary yet, load it asynchronously using readAsync.
  if (!wasmBinary) {
    // Fetch the binary using readAsync
    return readAsync(binaryFile).then(response => new Uint8Array( /** @type{!ArrayBuffer} */response),
    // Fall back to getBinarySync if readAsync fails
    () => getBinarySync(binaryFile));
  }

  // Otherwise, getBinarySync should be able to get it synchronously
  return Promise.resolve().then(() => getBinarySync(binaryFile));
}
function instantiateArrayBuffer(binaryFile, imports, receiver) {
  return getBinaryPromise(binaryFile).then(binary => {
    return WebAssembly.instantiate(binary, imports);
  }).then(receiver, reason => {
    err(`failed to asynchronously prepare wasm: ${reason}`);

    // Warn on some common problems.
    if (isFileURI(wasmBinaryFile)) {
      err(`warning: Loading from a file URI (${wasmBinaryFile}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`);
    }
    abort(reason);
  });
}
function instantiateAsync(binary, binaryFile, imports, callback) {
  if (!binary && typeof WebAssembly.instantiateStreaming == 'function' && !isDataURI(binaryFile) && typeof fetch == 'function') {
    return fetch(binaryFile, {
      credentials: 'same-origin'
    }).then(response => {
      // Suppress closure warning here since the upstream definition for
      // instantiateStreaming only allows Promise<Repsponse> rather than
      // an actual Response.
      // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure is fixed.
      /** @suppress {checkTypes} */
      var result = WebAssembly.instantiateStreaming(response, imports);
      return result.then(callback, function (reason) {
        // We expect the most common failure cause to be a bad MIME type for the binary,
        // in which case falling back to ArrayBuffer instantiation should work.
        err(`wasm streaming compile failed: ${reason}`);
        err('falling back to ArrayBuffer instantiation');
        return instantiateArrayBuffer(binaryFile, imports, callback);
      });
    });
  }
  return instantiateArrayBuffer(binaryFile, imports, callback);
}
function getWasmImports() {
  // prepare imports
  return {
    'env': wasmImports,
    'wasi_snapshot_preview1': wasmImports
  };
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
function createWasm() {
  var info = getWasmImports();
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  /** @param {WebAssembly.Module=} module*/
  function receiveInstance(instance, module) {
    wasmExports = instance.exports;
    wasmMemory = wasmExports['memory'];
    assert(wasmMemory, 'memory not found in wasm exports');
    updateMemoryViews();
    addOnInit(wasmExports['__wasm_call_ctors']);
    removeRunDependency('wasm-instantiate');
    return wasmExports;
  }
  // wait for the pthread pool (if any)
  addRunDependency('wasm-instantiate');

  // Prefer streaming instantiation if available.
  // Async compilation can be confusing when an error on the page overwrites Module
  // (for example, if the order of elements is wrong, and the one defining Module is
  // later), so we save Module and check it later.
  var trueModule = Module;
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    assert(Module === trueModule, 'the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?');
    trueModule = null;
    // TODO: Due to Closure regression https://github.com/google/closure-compiler/issues/3193, the above line no longer optimizes out down to the following line.
    // When the regression is fixed, can restore the above PTHREADS-enabled path.
    receiveInstance(result['instance']);
  }

  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  if (Module['instantiateWasm']) {
    try {
      return Module['instantiateWasm'](info, receiveInstance);
    } catch (e) {
      err(`Module.instantiateWasm callback failed with error: ${e}`);
      return false;
    }
  }
  if (!wasmBinaryFile) wasmBinaryFile = findWasmBinary();
  instantiateAsync(wasmBinary, wasmBinaryFile, info, receiveInstantiationResult);
  return {}; // no exports yet; we'll fill them in later
}

// include: runtime_debug.js
function legacyModuleProp(prop, newName) {
  let incoming = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : true;
  if (!Object.getOwnPropertyDescriptor(Module, prop)) {
    Object.defineProperty(Module, prop, {
      configurable: true,
      get() {
        let extra = incoming ? ' (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)' : '';
        abort(`\`Module.${prop}\` has been replaced by \`${newName}\`` + extra);
      }
    });
  }
}
function ignoredModuleProp(prop) {
  if (Object.getOwnPropertyDescriptor(Module, prop)) {
    abort(`\`Module.${prop}\` was supplied but \`${prop}\` not included in INCOMING_MODULE_JS_API`);
  }
}

// forcing the filesystem exports a few things by default
function isExportedByForceFilesystem(name) {
  return name === 'FS_createPath' || name === 'FS_createDataFile' || name === 'FS_createPreloadedFile' || name === 'FS_unlink' || name === 'addRunDependency' ||
  // The old FS has some functionality that WasmFS lacks.
  name === 'FS_createLazyFile' || name === 'FS_createDevice' || name === 'removeRunDependency';
}
function missingGlobal(sym, msg) {
  if (typeof globalThis != 'undefined') {
    Object.defineProperty(globalThis, sym, {
      configurable: true,
      get() {
        warnOnce(`\`${sym}\` is not longer defined by emscripten. ${msg}`);
        return undefined;
      }
    });
  }
}
missingGlobal('buffer', 'Please use HEAP8.buffer or wasmMemory.buffer');
missingGlobal('asm', 'Please use wasmExports instead');
function missingLibrarySymbol(sym) {
  if (typeof globalThis != 'undefined' && !Object.getOwnPropertyDescriptor(globalThis, sym)) {
    Object.defineProperty(globalThis, sym, {
      configurable: true,
      get() {
        // Can't `abort()` here because it would break code that does runtime
        // checks.  e.g. `if (typeof SDL === 'undefined')`.
        var msg = `\`${sym}\` is a library symbol and not included by default; add it to your library.js __deps or to DEFAULT_LIBRARY_FUNCS_TO_INCLUDE on the command line`;
        // DEFAULT_LIBRARY_FUNCS_TO_INCLUDE requires the name as it appears in
        // library.js, which means $name for a JS name with no prefix, or name
        // for a JS name like _name.
        var librarySymbol = sym;
        if (!librarySymbol.startsWith('_')) {
          librarySymbol = '$' + sym;
        }
        msg += ` (e.g. -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='${librarySymbol}')`;
        if (isExportedByForceFilesystem(sym)) {
          msg += '. Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you';
        }
        warnOnce(msg);
        return undefined;
      }
    });
  }
  // Any symbol that is not included from the JS library is also (by definition)
  // not exported on the Module object.
  unexportedRuntimeSymbol(sym);
}
function unexportedRuntimeSymbol(sym) {
  if (!Object.getOwnPropertyDescriptor(Module, sym)) {
    Object.defineProperty(Module, sym, {
      configurable: true,
      get() {
        var msg = `'${sym}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
        if (isExportedByForceFilesystem(sym)) {
          msg += '. Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you';
        }
        abort(msg);
      }
    });
  }
}

// Used by XXXXX_DEBUG settings to output debug messages.
function dbg() {
  // TODO(sbc): Make this configurable somehow.  Its not always convenient for
  // logging to show up as warnings.
  console.warn(...arguments);
}
// end include: runtime_debug.js
// === Body ===
// end include: preamble.js

/** @constructor */
function ExitStatus(status) {
  this.name = 'ExitStatus';
  this.message = `Program terminated with exit(${status})`;
  this.status = status;
}
var callRuntimeCallbacks = callbacks => {
  while (callbacks.length > 0) {
    // Pass the module as the first argument.
    callbacks.shift()(Module);
  }
};

/**
 * @param {number} ptr
 * @param {string} type
 */
function getValue(ptr) {
  let type = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 'i8';
  if (type.endsWith('*')) type = '*';
  switch (type) {
    case 'i1':
      return HEAP8[ptr];
    case 'i8':
      return HEAP8[ptr];
    case 'i16':
      return HEAP16[ptr >> 1];
    case 'i32':
      return HEAP32[ptr >> 2];
    case 'i64':
      return HEAP64[ptr >> 3];
    case 'float':
      return HEAPF32[ptr >> 2];
    case 'double':
      return HEAPF64[ptr >> 3];
    case '*':
      return HEAPU32[ptr >> 2];
    default:
      abort(`invalid type for getValue: ${type}`);
  }
}
var noExitRuntime = Module['noExitRuntime'] || true;
var ptrToString = ptr => {
  assert(typeof ptr === 'number');
  // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
  ptr >>>= 0;
  return '0x' + ptr.toString(16).padStart(8, '0');
};

/**
 * @param {number} ptr
 * @param {number} value
 * @param {string} type
 */
function setValue(ptr, value) {
  let type = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 'i8';
  if (type.endsWith('*')) type = '*';
  switch (type) {
    case 'i1':
      HEAP8[ptr] = value;
      break;
    case 'i8':
      HEAP8[ptr] = value;
      break;
    case 'i16':
      HEAP16[ptr >> 1] = value;
      break;
    case 'i32':
      HEAP32[ptr >> 2] = value;
      break;
    case 'i64':
      HEAP64[ptr >> 3] = BigInt(value);
      break;
    case 'float':
      HEAPF32[ptr >> 2] = value;
      break;
    case 'double':
      HEAPF64[ptr >> 3] = value;
      break;
    case '*':
      HEAPU32[ptr >> 2] = value;
      break;
    default:
      abort(`invalid type for setValue: ${type}`);
  }
}
var stackRestore = val => __emscripten_stack_restore(val);
var stackSave = () => _emscripten_stack_get_current();
var warnOnce = text => {
  warnOnce.shown || (warnOnce.shown = {});
  if (!warnOnce.shown[text]) {
    warnOnce.shown[text] = 1;
    err(text);
  }
};
var UTF8Decoder = typeof TextDecoder != 'undefined' ? new TextDecoder() : undefined;

/**
 * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
 * array that contains uint8 values, returns a copy of that string as a
 * Javascript String object.
 * heapOrArray is either a regular array, or a JavaScript typed array view.
 * @param {number} idx
 * @param {number=} maxBytesToRead
 * @return {string}
 */
var UTF8ArrayToString = (heapOrArray, idx, maxBytesToRead) => {
  var endIdx = idx + maxBytesToRead;
  var endPtr = idx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on
  // null terminator by itself.  Also, use the length info to avoid running tiny
  // strings through TextDecoder, since .subarray() allocates garbage.
  // (As a tiny code save trick, compare endPtr against endIdx using a negation,
  // so that undefined means Infinity)
  while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
  if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
    return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
  }
  var str = '';
  // If building with TextDecoder, we have already computed the string length
  // above, so test loop end condition against that
  while (idx < endPtr) {
    // For UTF8 byte structure, see:
    // http://en.wikipedia.org/wiki/UTF-8#Description
    // https://www.ietf.org/rfc/rfc2279.txt
    // https://tools.ietf.org/html/rfc3629
    var u0 = heapOrArray[idx++];
    if (!(u0 & 0x80)) {
      str += String.fromCharCode(u0);
      continue;
    }
    var u1 = heapOrArray[idx++] & 63;
    if ((u0 & 0xE0) == 0xC0) {
      str += String.fromCharCode((u0 & 31) << 6 | u1);
      continue;
    }
    var u2 = heapOrArray[idx++] & 63;
    if ((u0 & 0xF0) == 0xE0) {
      u0 = (u0 & 15) << 12 | u1 << 6 | u2;
    } else {
      if ((u0 & 0xF8) != 0xF0) warnOnce('Invalid UTF-8 leading byte ' + ptrToString(u0) + ' encountered when deserializing a UTF-8 string in wasm memory to a JS string!');
      u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
    }
    if (u0 < 0x10000) {
      str += String.fromCharCode(u0);
    } else {
      var ch = u0 - 0x10000;
      str += String.fromCharCode(0xD800 | ch >> 10, 0xDC00 | ch & 0x3FF);
    }
  }
  return str;
};

/**
 * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
 * emscripten HEAP, returns a copy of that string as a Javascript String object.
 *
 * @param {number} ptr
 * @param {number=} maxBytesToRead - An optional length that specifies the
 *   maximum number of bytes to read. You can omit this parameter to scan the
 *   string until the first 0 byte. If maxBytesToRead is passed, and the string
 *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
 *   string will cut short at that byte index (i.e. maxBytesToRead will not
 *   produce a string of exact length [ptr, ptr+maxBytesToRead[) N.B. mixing
 *   frequent uses of UTF8ToString() with and without maxBytesToRead may throw
 *   JS JIT optimizations off, so it is worth to consider consistently using one
 * @return {string}
 */
var UTF8ToString = (ptr, maxBytesToRead) => {
  assert(typeof ptr == 'number', `UTF8ToString expects a number (got ${typeof ptr})`);
  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : '';
};
var ___assert_fail = (condition, filename, line, func) => {
  abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [filename ? UTF8ToString(filename) : 'unknown filename', line, func ? UTF8ToString(func) : 'unknown function']);
};
var __emscripten_memcpy_js = (dest, src, num) => HEAPU8.copyWithin(dest, src, src + num);
var getHeapMax = () =>
// Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
// full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
// for any code that deals with heap sizes, which would require special
// casing all heap size related code to treat 0 specially.
2147483648;
var growMemory = size => {
  var b = wasmMemory.buffer;
  var pages = (size - b.byteLength + 65535) / 65536;
  try {
    // round size grow request up to wasm page size (fixed 64KB per spec)
    wasmMemory.grow(pages); // .grow() takes a delta compared to the previous size
    updateMemoryViews();
    return 1 /*success*/;
  } catch (e) {
    err(`growMemory: Attempted to grow heap from ${b.byteLength} bytes to ${size} bytes, but got error: ${e}`);
  }
  // implicit 0 return to save code size (caller will cast "undefined" into 0
  // anyhow)
};
var _emscripten_resize_heap = requestedSize => {
  var oldSize = HEAPU8.length;
  // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
  requestedSize >>>= 0;
  // With multithreaded builds, races can happen (another thread might increase the size
  // in between), so return a failure, and let the caller retry.
  assert(requestedSize > oldSize);

  // Memory resize rules:
  // 1.  Always increase heap size to at least the requested size, rounded up
  //     to next page multiple.
  // 2a. If MEMORY_GROWTH_LINEAR_STEP == -1, excessively resize the heap
  //     geometrically: increase the heap size according to
  //     MEMORY_GROWTH_GEOMETRIC_STEP factor (default +20%), At most
  //     overreserve by MEMORY_GROWTH_GEOMETRIC_CAP bytes (default 96MB).
  // 2b. If MEMORY_GROWTH_LINEAR_STEP != -1, excessively resize the heap
  //     linearly: increase the heap size by at least
  //     MEMORY_GROWTH_LINEAR_STEP bytes.
  // 3.  Max size for the heap is capped at 2048MB-WASM_PAGE_SIZE, or by
  //     MAXIMUM_MEMORY, or by ASAN limit, depending on which is smallest
  // 4.  If we were unable to allocate as much memory, it may be due to
  //     over-eager decision to excessively reserve due to (3) above.
  //     Hence if an allocation fails, cut down on the amount of excess
  //     growth, in an attempt to succeed to perform a smaller allocation.

  // A limit is set for how much we can grow. We should not exceed that
  // (the wasm binary specifies it, so if we tried, we'd fail anyhow).
  var maxHeapSize = getHeapMax();
  if (requestedSize > maxHeapSize) {
    err(`Cannot enlarge memory, requested ${requestedSize} bytes, but the limit is ${maxHeapSize} bytes!`);
    return false;
  }
  var alignUp = (x, multiple) => x + (multiple - x % multiple) % multiple;

  // Loop through potential heap size increases. If we attempt a too eager
  // reservation that fails, cut down on the attempted size and reserve a
  // smaller bump instead. (max 3 times, chosen somewhat arbitrarily)
  for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
    var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown); // ensure geometric growth
    // but limit overreserving (default to capping at +96MB overgrowth at most)
    overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
    var newSize = Math.min(maxHeapSize, alignUp(Math.max(requestedSize, overGrownHeapSize), 65536));
    var replacement = growMemory(newSize);
    if (replacement) {
      return true;
    }
  }
  err(`Failed to grow the heap from ${oldSize} bytes to ${newSize} bytes, not enough memory!`);
  return false;
};
var ENV = {};
var getExecutableName = () => {
  return thisProgram || './this.program';
};
var getEnvStrings = () => {
  if (!getEnvStrings.strings) {
    // Default values.
    // Browser language detection #8751
    var lang = (typeof navigator == 'object' && navigator.languages && navigator.languages[0] || 'C').replace('-', '_') + '.UTF-8';
    var env = {
      'USER': 'web_user',
      'LOGNAME': 'web_user',
      'PATH': '/',
      'PWD': '/',
      'HOME': '/home/web_user',
      'LANG': lang,
      '_': getExecutableName()
    };
    // Apply the user-provided values, if any.
    for (var x in ENV) {
      // x is a key in ENV; if ENV[x] is undefined, that means it was
      // explicitly set to be so. We allow user code to do that to
      // force variables with default values to remain unset.
      if (ENV[x] === undefined) delete env[x];else env[x] = ENV[x];
    }
    var strings = [];
    for (var x in env) {
      strings.push(`${x}=${env[x]}`);
    }
    getEnvStrings.strings = strings;
  }
  return getEnvStrings.strings;
};
var stringToAscii = (str, buffer) => {
  for (var i = 0; i < str.length; ++i) {
    assert(str.charCodeAt(i) === (str.charCodeAt(i) & 0xff));
    HEAP8[buffer++] = str.charCodeAt(i);
  }
  // Null-terminate the string
  HEAP8[buffer] = 0;
};
var _environ_get = (__environ, environ_buf) => {
  var bufSize = 0;
  getEnvStrings().forEach((string, i) => {
    var ptr = environ_buf + bufSize;
    HEAPU32[__environ + i * 4 >> 2] = ptr;
    stringToAscii(string, ptr);
    bufSize += string.length + 1;
  });
  return 0;
};
var _environ_sizes_get = (penviron_count, penviron_buf_size) => {
  var strings = getEnvStrings();
  HEAPU32[penviron_count >> 2] = strings.length;
  var bufSize = 0;
  strings.forEach(string => bufSize += string.length + 1);
  HEAPU32[penviron_buf_size >> 2] = bufSize;
  return 0;
};
function _js_activate_timer() {
  timer_reference = performance.now();
  var frame = function (now) {
    timer = window.requestAnimationFrame(frame);
    // The callback might call js_deactivate_timer() below.
    timer_callback((now - timer_reference) / 1000.0);
    timer_reference = now;
  };
  timer = window.requestAnimationFrame(frame);
}

function tradueixCA(text) {
  var map = {
    "Game ID": "Identificador de la partida",
    "Game random seed": "Llavor aleatòria de la partida",
    "Pegs per guess": "Fitxes per intent",
    "Colours": "Colors",
    "Label colours with numbers": "Identifica els colors amb números",
    "Allow blanks": "Permet caselles buides",
    "Allow duplicates": "Permet colors repetits",
    "Guesses": "Intents",
    "Guess": "Intent",
    "This game does not support the Solve operation": "Aquest joc no permet resoldre la partida automàticament",
    "Cannot handle this version of the saved game file format": "No es pot llegir aquesta versió del fitxer de partida desada",
    "Must have at least one guess": "Cal fer com a mínim un intent",
    "Too many colours": "Massa colors",
    "Disallowing multiple colours requires at least as many colours as pegs": "Si no es permet repetir colors, cal que hi hagi almenys tants colors com fitxes"
  };
  return Object.prototype.hasOwnProperty.call(map, text) ? map[text] : text;
}

function _js_add_preset(menuid, ptr, value) {
  var name = tradueixCA(UTF8ToString(ptr));
  var item = document.createElement("li");
  var label = document.createElement("label");
  var tick = document.createElement("input");
  tick.type = "radio";
  tick.className = "tick";
  tick.name = "preset";
  tick.value = value;
  label.appendChild(tick);
  label.appendChild(document.createTextNode(" " + name));
  item.appendChild(label);
  gametypesubmenus[menuid].appendChild(item);
  tick.onclick = function (event) {
    if (dlg_dimmer === null) {
      command(2);
    }
  };
}
function _js_add_preset_submenu(menuid, ptr, value) {
  var name = tradueixCA(UTF8ToString(ptr));
  var item = document.createElement("li");
  // We still create a transparent tick element, even though it
  // won't ever be selected, to make submenu titles line up
  // nicely with their neighbours.
  var label = document.createElement("div");
  var tick = document.createElement("span");
  tick.className = "tick";
  label.appendChild(tick);
  label.tabIndex = 0;
  label.appendChild(document.createTextNode(" " + name));
  item.appendChild(label);
  var submenu = document.createElement("ul");
  label.appendChild(submenu);
  gametypesubmenus[menuid].appendChild(item);
  var toret = gametypesubmenus.length;
  gametypesubmenus.push(submenu);
  return toret;
}
function _js_canvas_blitter_load(dr, bl, x, y) {
  // Temporarily turn off the effects of fe_scale so we can do
  // it ourselves.
  ctx.save();
  ctx.resetTransform();
  x *= fe_scale;
  y *= fe_scale;
  ctx.drawImage(blitters.get(bl), x, y);
  ctx.restore();
}
function _js_canvas_blitter_save(dr, bl, x, y) {
  var blitter_ctx = blitters.get(bl).getContext('2d', {
    alpha: false
  });
  x *= fe_scale;
  y *= fe_scale;
  blitter_ctx.drawImage(offscreen_canvas, -x, -y);
}
function _js_canvas_clip(dr, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
}
function _js_canvas_draw_circle(dr, x, y, r, fill, outline) {
  ctx.beginPath();
  ctx.arc(x + 0.5, y + 0.5, r, 0, 2 * Math.PI);
  if (fill >= 0) {
    ctx.fillStyle = colours[fill];
    ctx.fill();
  }
  ctx.lineWidth = '1';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = colours[outline];
  ctx.stroke();
}
function _js_canvas_draw_line(x1, y1, x2, y2, width, colour) {
  colour = colours[colour];
  ctx.beginPath();
  ctx.moveTo(x1 + 0.5, y1 + 0.5);
  ctx.lineTo(x2 + 0.5, y2 + 0.5);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = colour;
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fillRect(x1, y1, 1, 1);
  ctx.fillRect(x2, y2, 1, 1);
}
function _js_canvas_draw_poly(dr, pointptr, npoints, fill, outline) {
  ctx.beginPath();
  ctx.moveTo(getValue(pointptr, 'i32') + 0.5, getValue(pointptr + 4, 'i32') + 0.5);
  for (var i = 1; i < npoints; i++) ctx.lineTo(getValue(pointptr + 8 * i, 'i32') + 0.5, getValue(pointptr + 8 * i + 4, 'i32') + 0.5);
  ctx.closePath();
  if (fill >= 0) {
    ctx.fillStyle = colours[fill];
    ctx.fill();
  }
  ctx.lineWidth = '1';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = colours[outline];
  ctx.stroke();
}
function _js_canvas_draw_rect(dr, x, y, w, h, colour) {
  ctx.fillStyle = colours[colour];
  ctx.fillRect(x, y, w, h);
}
function _js_canvas_draw_text(x, y, halign, colour, fontsize, monospaced, text) {
  canvas_set_font(ctx, fontsize, monospaced);
  ctx.fillStyle = colours[colour];
  ctx.textAlign = halign == 0 ? 'left' : halign == 1 ? 'center' : 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(UTF8ToString(text), x, y);
}
function _js_canvas_draw_update(dr, x, y, w, h) {
  /*
   * Currently we do this in a really simple way, just by taking
   * the smallest rectangle containing all updates so far. We
   * could instead keep the data in a richer form (e.g. retain
   * multiple smaller rectangles needing update, and only redraw
   * the whole thing beyond a certain threshold) but this will
   * do for now.
   */
  x *= fe_scale;
  y *= fe_scale;
  w *= fe_scale;
  h *= fe_scale;
  if (update_xmin === undefined || update_xmin > x) update_xmin = x;
  if (update_ymin === undefined || update_ymin > y) update_ymin = y;
  if (update_xmax === undefined || update_xmax < x + w) update_xmax = x + w;
  if (update_ymax === undefined || update_ymax < y + h) update_ymax = y + h;
}
function _js_canvas_end_draw(dr) {
  if (update_xmin !== undefined) {
    var onscreen_ctx = onscreen_canvas.getContext('2d', {
      alpha: false
    });
    onscreen_ctx.drawImage(offscreen_canvas, update_xmin, update_ymin, update_xmax - update_xmin, update_ymax - update_ymin, update_xmin, update_ymin, update_xmax - update_xmin, update_ymax - update_ymin);
  }
}
function _js_canvas_find_font_midpoint(height, monospaced) {
  if (height == 0) {
    // Handle this degenerate case by hand. Otherwise we end
    // up passing height=0 to the getImageData call below,
    // causing browsers to report errors.
    return 0;
  }

  // Resolve the font into a string.
  var ctx1 = onscreen_canvas.getContext('2d', {
    alpha: false
  });
  canvas_set_font(ctx1, height, monospaced);

  // Reuse cached value if possible
  if (midpoint_cache[ctx1.font] !== undefined) return midpoint_cache[ctx1.font];

  // Find the width of the string
  var width = ctx1.measureText(midpoint_test_str).width + 1 | 0;

  // Construct a test canvas of appropriate size, initialise it to
  // black, and draw the string on it in white
  var measure_canvas = document.createElement('canvas');
  var ctx2 = measure_canvas.getContext('2d', {
    alpha: false
  });
  ctx2.canvas.width = width;
  ctx2.canvas.height = 2 * height;
  ctx2.fillStyle = "#000000";
  ctx2.fillRect(0, 0, width, 2 * height);
  var baseline = 1.5 * height | 0;
  ctx2.fillStyle = "#ffffff";
  canvas_set_font(ctx2, height, monospaced);
  ctx2.fillText(midpoint_test_str, 0, baseline);

  // Scan the contents of the test canvas to find the top and bottom
  // set pixels.
  var pixels = ctx2.getImageData(0, 0, width, 2 * height).data;
  var ymin = 2 * height,
    ymax = -1;
  for (var y = 0; y < 2 * height; y++) {
    for (var x = 0; x < width; x++) {
      if (pixels[4 * (y * width + x)] != 0) {
        if (ymin > y) ymin = y;
        if (ymax < y) ymax = y;
        break;
      }
    }
  }
  var ret = baseline - (ymin + ymax) / 2 | 0;
  midpoint_cache[ctx1.font] = ret;
  return ret;
}
function _js_canvas_free_blitter(bl) {
  blitters.delete(bl);
}
function _js_canvas_get_preferred_size(wp, hp) {
  if (containing_div !== null) {
    var dpr = window.devicePixelRatio || 1;
    setValue(wp, containing_div.clientWidth * dpr, "i32");
    setValue(hp, containing_div.clientHeight * dpr, "i32");
    return true;
  }
  return false;
}
function _js_canvas_new_blitter(bl, w, h) {
  w *= fe_scale;
  h *= fe_scale;
  var new_blitter = document.createElement("canvas");
  new_blitter.width = w;
  new_blitter.height = h;
  blitters.set(bl, new_blitter);
}
function _js_canvas_remove_statusbar() {
  if (statusbar !== null) statusbar.parentNode.removeChild(statusbar);
  statusbar = null;
}
function _js_canvas_set_size(w, h, new_fe_scale) {
  onscreen_canvas.width = w;
  offscreen_canvas.width = w;
  if (resizable_div !== null) resizable_div.style.width = w / (window.devicePixelRatio || 1) + "px";else {
    onscreen_canvas.style.width = w / (window.devicePixelRatio || 1) + "px";
    onscreen_canvas.style.height = h / (window.devicePixelRatio || 1) + "px";
  }
  onscreen_canvas.height = h;
  offscreen_canvas.height = h;
  fe_scale = new_fe_scale;
  ctx.resetTransform();
  ctx.scale(fe_scale, fe_scale);
}
function _js_canvas_start_draw(dr) {
  update_xmin = update_xmax = update_ymin = update_ymax = undefined;
}
function _js_canvas_status_bar(dr, ptr) {
  statusbar.textContent = tradueixCA(UTF8ToString(ptr));
}
function _js_canvas_unclip(dr) {
  ctx.restore();
}
function _js_deactivate_timer() {
  window.cancelAnimationFrame(timer);
}
function _js_default_colour(output) {
  var col = window.getComputedStyle(onscreen_canvas).backgroundColor;
  /* We only support opaque sRGB colours. */
  var m = col.match(/^rgb\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)\)$/);
  if (m) {
    setValue(output, +m[1] / 255, "float");
    setValue(output + 4, +m[2] / 255, "float");
    setValue(output + 8, +m[3] / 255, "float");
  }
}
function _js_dialog_boolean(index, title, initvalue) {
  var checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = initvalue != 0;
  var checkboxlabel = document.createElement("label");
  checkboxlabel.appendChild(checkbox);
  checkboxlabel.appendChild(document.createTextNode(tradueixCA(UTF8ToString(title))));
  dlg_form.appendChild(checkboxlabel);
  dlg_form.appendChild(document.createElement("br"));
  dlg_return_funcs.push(function () {
    dlg_return_ival(index, checkbox.checked ? 1 : 0);
  });
}
function _js_dialog_choices(index, title, choicelist, initvalue) {
  var label = document.createElement("label");
  label.textContent = tradueixCA(UTF8ToString(title));
  dlg_form.appendChild(label);
  var dropdown = document.createElement("select");
  var choicestr = UTF8ToString(choicelist);
  var items = choicestr.slice(1).split(choicestr[0]).map(tradueixCA);
  var options = [];
  for (var i in items) {
    var option = document.createElement("option");
    option.value = i;
    option.appendChild(document.createTextNode(items[i]));
    if (i == initvalue) option.selected = true;
    dropdown.appendChild(option);
    options.push(option);
  }
  label.appendChild(dropdown);
  dlg_form.appendChild(document.createElement("br"));
  dlg_return_funcs.push(function () {
    var val = 0;
    for (var i in options) {
      if (options[i].selected) {
        val = options[i].value;
        break;
      }
    }
    dlg_return_ival(index, val);
  });
}
function _js_dialog_cleanup() {
  dialog_cleanup();
}
function _js_dialog_init(titletext) {
  dialog_init(UTF8ToString(titletext));
}
function _js_dialog_launch() {
  dialog_launch(function (event) {
    for (var i in dlg_return_funcs) dlg_return_funcs[i]();
    command(3); // OK
  }, function (event) {
    command(4); // Cancel
  });
}
function _js_dialog_string(index, title, initialtext) {
  var label = document.createElement("label");
  label.textContent = tradueixCA(UTF8ToString(title));
  dlg_form.appendChild(label);
  var editbox = document.createElement("input");
  editbox.type = "text";
  editbox.value = UTF8ToString(initialtext);
  label.appendChild(editbox);
  dlg_form.appendChild(document.createElement("br"));
  dlg_return_funcs.push(function () {
    dlg_return_sval(index, editbox.value);
  });
}
function _js_enable_undo_redo(undo, redo) {
  disable_menu_item(undo_button, undo == 0);
  disable_menu_item(redo_button, redo == 0);
}
function _js_error_box(ptr) {
  alert(tradueixCA(UTF8ToString(ptr)));
}
function _js_focus_canvas() {
  onscreen_canvas.focus();
}
function _js_get_date_64(ptr) {
  var d = new Date().valueOf();
  setValue(ptr, d, 'i64');
}
function _js_get_device_pixel_ratio() {
  return window.devicePixelRatio || 1;
}
function _js_get_selected_preset() {
  return menuform.elements["preset"].value;
}
function _js_init_puzzle() {
  initPuzzle();
}
function _js_load_prefs(me) {
  function load_prefs_from_string(prefsdata) {
    if (prefsdata !== undefined && prefsdata !== null) {
      var lenbytes = lengthBytesUTF8(prefsdata) + 1;
      var dest = _malloc(lenbytes);
      if (dest != 0) {
        stringToUTF8(prefsdata, dest, lenbytes);
        prefs_load_callback(me, dest);
        _free(dest);
      }
    }
  }
  // Load any default preferences embedded in HTML.
  for (var prefsscript of document.querySelectorAll("script.preferences")) load_prefs_from_string(prefsscript.textContent);
  // Load saved preferences if they exist.
  try {
    load_prefs_from_string(localStorage.getItem(location.pathname + " preferences"));
  } catch (error) {
    // Log the error but otherwise pretend the settings were
    // absent.
    console.warn(error);
  }
}
function _js_post_init() {
  post_init();
}
function _js_remove_solve_button() {
  if (solve_button === null) return;
  var solve_item = solve_button.closest("li");
  if (solve_item === null) return;
  solve_item.parentNode.removeChild(solve_item);
  solve_button = null;
}
function _js_remove_type_dropdown() {
  if (gametypelist === null) return;
  var gametypeitem = gametypelist.closest("li");
  if (gametypeitem === null) return;
  gametypeitem.parentNode.removeChild(gametypeitem);
  gametypelist = null;
}
function _js_save_prefs(buf) {
  var prefsdata = UTF8ToString(buf);
  try {
    localStorage.setItem(location.pathname + " preferences", prefsdata);
  } catch (error) {
    // Tell the user their preferences have not been saved.
    console.error(error);
    alert("Saving of preferences failed: " + error.message);
  }
}
function _js_savefile_read(buf, len) {
  return savefile_read_callback(buf, len);
}
function _js_select_preset(n) {
  menuform.elements["preset"].value = n;
}
function _js_set_colour(colour_number, colour_string) {
  colours[colour_number] = UTF8ToString(colour_string);
  if (colour_number == 0) document.documentElement.style.setProperty("--puzzle-background", colours[colour_number]);
}
function _js_update_key_labels(lsk_ptr, csk_ptr) {
  var elem;
  var lsk_text = UTF8ToString(lsk_ptr);
  var csk_text = UTF8ToString(csk_ptr);
  for (elem of document.querySelectorAll("#puzzle .lsk")) elem.textContent = lsk_text == csk_text ? "" : lsk_text;
  for (elem of document.querySelectorAll("#puzzle .csk")) elem.textContent = csk_text;
}
function _js_update_permalinks(desc, seed) {
  desc = encodeURI(UTF8ToString(desc)).replace(/#/g, "%23");
  if (permalink_desc !== null) permalink_desc.href = "#" + desc;
  if (permalink_seed !== null) {
    if (seed == 0) {
      permalink_seed.style.display = "none";
    } else {
      seed = encodeURI(UTF8ToString(seed)).replace(/#/g, "%23");
      ;
      permalink_seed.href = "#" + seed;
      permalink_seed.style.display = "";
    }
  }
}
var runtimeKeepaliveCounter = 0;
var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
var _proc_exit = code => {
  EXITSTATUS = code;
  if (!keepRuntimeAlive()) {
    var _Module$onExit, _Module4;
    (_Module$onExit = (_Module4 = Module)['onExit']) === null || _Module$onExit === void 0 || _Module$onExit.call(_Module4, code);
    ABORT = true;
  }
  quit_(code, new ExitStatus(code));
};

/** @param {boolean|number=} implicit */
var exitJS = (status, implicit) => {
  EXITSTATUS = status;
  checkUnflushedContent();

  // if exit() was called explicitly, warn the user if the runtime isn't actually being shut down
  if (keepRuntimeAlive() && !implicit) {
    var msg = `program exited (with status: ${status}), but keepRuntimeAlive() is set (counter=${runtimeKeepaliveCounter}) due to an async operation, so halting execution but not exiting the runtime or preventing further async execution (you can use emscripten_force_exit, if you want to force a true shutdown)`;
    err(msg);
  }
  _proc_exit(status);
};
var handleException = e => {
  // Certain exception types we do not treat as errors since they are used for
  // internal control flow.
  // 1. ExitStatus, which is thrown by exit()
  // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
  //    that wish to return to JS event loop.
  if (e instanceof ExitStatus || e == 'unwind') {
    return EXITSTATUS;
  }
  checkStackCookie();
  if (e instanceof WebAssembly.RuntimeError) {
    if (_emscripten_stack_get_current() <= 0) {
      err('Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 65536)');
    }
  }
  quit_(1, e);
};
var lengthBytesUTF8 = str => {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
    // unit, not a Unicode code point of the character! So decode
    // UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var c = str.charCodeAt(i); // possibly a lead surrogate
    if (c <= 0x7F) {
      len++;
    } else if (c <= 0x7FF) {
      len += 2;
    } else if (c >= 0xD800 && c <= 0xDFFF) {
      len += 4;
      ++i;
    } else {
      len += 3;
    }
  }
  return len;
};
var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
  assert(typeof str === 'string', `stringToUTF8Array expects a string (got ${typeof str})`);
  // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
  // undefined and false each don't write out any bytes.
  if (!(maxBytesToWrite > 0)) return 0;
  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1; // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
    // unit, not a Unicode code point of the character! So decode
    // UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
    // and https://www.ietf.org/rfc/rfc2279.txt
    // and https://tools.ietf.org/html/rfc3629
    var u = str.charCodeAt(i); // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) {
      var u1 = str.charCodeAt(++i);
      u = 0x10000 + ((u & 0x3FF) << 10) | u1 & 0x3FF;
    }
    if (u <= 0x7F) {
      if (outIdx >= endIdx) break;
      heap[outIdx++] = u;
    } else if (u <= 0x7FF) {
      if (outIdx + 1 >= endIdx) break;
      heap[outIdx++] = 0xC0 | u >> 6;
      heap[outIdx++] = 0x80 | u & 63;
    } else if (u <= 0xFFFF) {
      if (outIdx + 2 >= endIdx) break;
      heap[outIdx++] = 0xE0 | u >> 12;
      heap[outIdx++] = 0x80 | u >> 6 & 63;
      heap[outIdx++] = 0x80 | u & 63;
    } else {
      if (outIdx + 3 >= endIdx) break;
      if (u > 0x10FFFF) warnOnce('Invalid Unicode code point ' + ptrToString(u) + ' encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).');
      heap[outIdx++] = 0xF0 | u >> 18;
      heap[outIdx++] = 0x80 | u >> 12 & 63;
      heap[outIdx++] = 0x80 | u >> 6 & 63;
      heap[outIdx++] = 0x80 | u & 63;
    }
  }
  // Null-terminate the pointer to the buffer.
  heap[outIdx] = 0;
  return outIdx - startIdx;
};
var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
};
var stackAlloc = sz => __emscripten_stack_alloc(sz);
var stringToUTF8OnStack = str => {
  var size = lengthBytesUTF8(str) + 1;
  var ret = stackAlloc(size);
  stringToUTF8(str, ret, size);
  return ret;
};
var getCFunc = ident => {
  var func = Module['_' + ident]; // closure exported function
  assert(func, 'Cannot call unknown function ' + ident + ', make sure it is exported');
  return func;
};
var writeArrayToMemory = (array, buffer) => {
  assert(array.length >= 0, 'writeArrayToMemory array must have a length (should be an array or typed array)');
  HEAP8.set(array, buffer);
};

/**
 * @param {string|null=} returnType
 * @param {Array=} argTypes
 * @param {Arguments|Array=} args
 * @param {Object=} opts
 */
var ccall = (ident, returnType, argTypes, args, opts) => {
  // For fast lookup of conversion functions
  var toC = {
    'string': str => {
      var ret = 0;
      if (str !== null && str !== undefined && str !== 0) {
        // null string
        // at most 4 bytes per UTF-8 code point, +1 for the trailing '\0'
        ret = stringToUTF8OnStack(str);
      }
      return ret;
    },
    'array': arr => {
      var ret = stackAlloc(arr.length);
      writeArrayToMemory(arr, ret);
      return ret;
    }
  };
  function convertReturnValue(ret) {
    if (returnType === 'string') {
      return UTF8ToString(ret);
    }
    if (returnType === 'boolean') return Boolean(ret);
    return ret;
  }
  var func = getCFunc(ident);
  var cArgs = [];
  var stack = 0;
  assert(returnType !== 'array', 'Return type should not be "array".');
  if (args) {
    for (var i = 0; i < args.length; i++) {
      var converter = toC[argTypes[i]];
      if (converter) {
        if (stack === 0) stack = stackSave();
        cArgs[i] = converter(args[i]);
      } else {
        cArgs[i] = args[i];
      }
    }
  }
  var ret = func(...cArgs);
  function onDone(ret) {
    if (stack !== 0) stackRestore(stack);
    return convertReturnValue(ret);
  }
  ret = onDone(ret);
  return ret;
};

/**
 * @param {string=} returnType
 * @param {Array=} argTypes
 * @param {Object=} opts
 */
var cwrap = (ident, returnType, argTypes, opts) => {
  return function () {
    for (var _len = arguments.length, args = new Array(_len), _key2 = 0; _key2 < _len; _key2++) {
      args[_key2] = arguments[_key2];
    }
    return ccall(ident, returnType, argTypes, args, opts);
  };
};
function checkIncomingModuleAPI() {
  ignoredModuleProp('fetchSettings');
}
var wasmImports = {
  /** @export */
  __assert_fail: ___assert_fail,
  /** @export */
  _emscripten_memcpy_js: __emscripten_memcpy_js,
  /** @export */
  emscripten_resize_heap: _emscripten_resize_heap,
  /** @export */
  environ_get: _environ_get,
  /** @export */
  environ_sizes_get: _environ_sizes_get,
  /** @export */
  js_activate_timer: _js_activate_timer,
  /** @export */
  js_add_preset: _js_add_preset,
  /** @export */
  js_add_preset_submenu: _js_add_preset_submenu,
  /** @export */
  js_canvas_blitter_load: _js_canvas_blitter_load,
  /** @export */
  js_canvas_blitter_save: _js_canvas_blitter_save,
  /** @export */
  js_canvas_clip: _js_canvas_clip,
  /** @export */
  js_canvas_draw_circle: _js_canvas_draw_circle,
  /** @export */
  js_canvas_draw_line: _js_canvas_draw_line,
  /** @export */
  js_canvas_draw_poly: _js_canvas_draw_poly,
  /** @export */
  js_canvas_draw_rect: _js_canvas_draw_rect,
  /** @export */
  js_canvas_draw_text: _js_canvas_draw_text,
  /** @export */
  js_canvas_draw_update: _js_canvas_draw_update,
  /** @export */
  js_canvas_end_draw: _js_canvas_end_draw,
  /** @export */
  js_canvas_find_font_midpoint: _js_canvas_find_font_midpoint,
  /** @export */
  js_canvas_free_blitter: _js_canvas_free_blitter,
  /** @export */
  js_canvas_get_preferred_size: _js_canvas_get_preferred_size,
  /** @export */
  js_canvas_new_blitter: _js_canvas_new_blitter,
  /** @export */
  js_canvas_remove_statusbar: _js_canvas_remove_statusbar,
  /** @export */
  js_canvas_set_size: _js_canvas_set_size,
  /** @export */
  js_canvas_start_draw: _js_canvas_start_draw,
  /** @export */
  js_canvas_status_bar: _js_canvas_status_bar,
  /** @export */
  js_canvas_unclip: _js_canvas_unclip,
  /** @export */
  js_deactivate_timer: _js_deactivate_timer,
  /** @export */
  js_default_colour: _js_default_colour,
  /** @export */
  js_dialog_boolean: _js_dialog_boolean,
  /** @export */
  js_dialog_choices: _js_dialog_choices,
  /** @export */
  js_dialog_cleanup: _js_dialog_cleanup,
  /** @export */
  js_dialog_init: _js_dialog_init,
  /** @export */
  js_dialog_launch: _js_dialog_launch,
  /** @export */
  js_dialog_string: _js_dialog_string,
  /** @export */
  js_enable_undo_redo: _js_enable_undo_redo,
  /** @export */
  js_error_box: _js_error_box,
  /** @export */
  js_focus_canvas: _js_focus_canvas,
  /** @export */
  js_get_date_64: _js_get_date_64,
  /** @export */
  js_get_device_pixel_ratio: _js_get_device_pixel_ratio,
  /** @export */
  js_get_selected_preset: _js_get_selected_preset,
  /** @export */
  js_init_puzzle: _js_init_puzzle,
  /** @export */
  js_load_prefs: _js_load_prefs,
  /** @export */
  js_post_init: _js_post_init,
  /** @export */
  js_remove_solve_button: _js_remove_solve_button,
  /** @export */
  js_remove_type_dropdown: _js_remove_type_dropdown,
  /** @export */
  js_save_prefs: _js_save_prefs,
  /** @export */
  js_savefile_read: _js_savefile_read,
  /** @export */
  js_select_preset: _js_select_preset,
  /** @export */
  js_set_colour: _js_set_colour,
  /** @export */
  js_update_key_labels: _js_update_key_labels,
  /** @export */
  js_update_permalinks: _js_update_permalinks
};
var wasmExports = createWasm();
var ___wasm_call_ctors = createExportWrapper('__wasm_call_ctors', 0);
var _malloc = Module['_malloc'] = createExportWrapper('malloc', 1);
var _free = Module['_free'] = createExportWrapper('free', 1);
var _timer_callback = Module['_timer_callback'] = createExportWrapper('timer_callback', 1);
var _rescale_puzzle = Module['_rescale_puzzle'] = createExportWrapper('rescale_puzzle', 0);
var _resize_puzzle = Module['_resize_puzzle'] = createExportWrapper('resize_puzzle', 2);
var _restore_puzzle_size = Module['_restore_puzzle_size'] = createExportWrapper('restore_puzzle_size', 2);
var _mousedown = Module['_mousedown'] = createExportWrapper('mousedown', 3);
var _mouseup = Module['_mouseup'] = createExportWrapper('mouseup', 3);
var _mousemove = Module['_mousemove'] = createExportWrapper('mousemove', 3);
var _key = Module['_key'] = createExportWrapper('key', 6);
var _dlg_return_sval = Module['_dlg_return_sval'] = createExportWrapper('dlg_return_sval', 2);
var _dlg_return_ival = Module['_dlg_return_ival'] = createExportWrapper('dlg_return_ival', 2);
var _command = Module['_command'] = createExportWrapper('command', 1);
var _get_text_format = Module['_get_text_format'] = createExportWrapper('get_text_format', 0);
var _free_text_format = Module['_free_text_format'] = createExportWrapper('free_text_format', 1);
var _get_save_file = Module['_get_save_file'] = createExportWrapper('get_save_file', 0);
var _free_save_file = Module['_free_save_file'] = createExportWrapper('free_save_file', 1);
var _load_game = Module['_load_game'] = createExportWrapper('load_game', 0);
var _prefs_load_callback = Module['_prefs_load_callback'] = createExportWrapper('prefs_load_callback', 2);
var _main = Module['_main'] = createExportWrapper('__main_argc_argv', 2);
var _fflush = createExportWrapper('fflush', 1);
var _emscripten_stack_init = () => (_emscripten_stack_init = wasmExports['emscripten_stack_init'])();
var _emscripten_stack_get_free = () => (_emscripten_stack_get_free = wasmExports['emscripten_stack_get_free'])();
var _emscripten_stack_get_base = () => (_emscripten_stack_get_base = wasmExports['emscripten_stack_get_base'])();
var _emscripten_stack_get_end = () => (_emscripten_stack_get_end = wasmExports['emscripten_stack_get_end'])();
var __emscripten_stack_restore = a0 => (__emscripten_stack_restore = wasmExports['_emscripten_stack_restore'])(a0);
var __emscripten_stack_alloc = a0 => (__emscripten_stack_alloc = wasmExports['_emscripten_stack_alloc'])(a0);
var _emscripten_stack_get_current = () => (_emscripten_stack_get_current = wasmExports['emscripten_stack_get_current'])();

// include: postamble.js
// === Auto-generated postamble setup entry stuff ===

Module['cwrap'] = cwrap;
var missingLibrarySymbols = ['writeI53ToI64', 'writeI53ToI64Clamped', 'writeI53ToI64Signaling', 'writeI53ToU64Clamped', 'writeI53ToU64Signaling', 'readI53FromI64', 'readI53FromU64', 'convertI32PairToI53', 'convertI32PairToI53Checked', 'convertU32PairToI53', 'bigintToI53Checked', 'getTempRet0', 'setTempRet0', 'zeroMemory', 'isLeapYear', 'ydayFromDate', 'arraySum', 'addDays', 'strError', 'inetPton4', 'inetNtop4', 'inetPton6', 'inetNtop6', 'readSockaddr', 'writeSockaddr', 'initRandomFill', 'randomFill', 'emscriptenLog', 'readEmAsmArgs', 'jstoi_q', 'listenOnce', 'autoResumeAudioContext', 'getDynCaller', 'dynCall', 'runtimeKeepalivePush', 'runtimeKeepalivePop', 'callUserCallback', 'maybeExit', 'asmjsMangle', 'asyncLoad', 'alignMemory', 'mmapAlloc', 'HandleAllocator', 'getNativeTypeSize', 'STACK_SIZE', 'STACK_ALIGN', 'POINTER_SIZE', 'ASSERTIONS', 'uleb128Encode', 'sigToWasmTypes', 'generateFuncType', 'convertJsFunctionToWasm', 'getEmptyTableSlot', 'updateTableMap', 'getFunctionAddress', 'addFunction', 'removeFunction', 'reallyNegative', 'unSign', 'strLen', 'reSign', 'formatString', 'intArrayFromString', 'intArrayToString', 'AsciiToString', 'UTF16ToString', 'stringToUTF16', 'lengthBytesUTF16', 'UTF32ToString', 'stringToUTF32', 'lengthBytesUTF32', 'stringToNewUTF8', 'registerKeyEventCallback', 'maybeCStringToJsString', 'findEventTarget', 'getBoundingClientRect', 'fillMouseEventData', 'registerMouseEventCallback', 'registerWheelEventCallback', 'registerUiEventCallback', 'registerFocusEventCallback', 'fillDeviceOrientationEventData', 'registerDeviceOrientationEventCallback', 'fillDeviceMotionEventData', 'registerDeviceMotionEventCallback', 'screenOrientation', 'fillOrientationChangeEventData', 'registerOrientationChangeEventCallback', 'fillFullscreenChangeEventData', 'registerFullscreenChangeEventCallback', 'JSEvents_requestFullscreen', 'JSEvents_resizeCanvasForFullscreen', 'registerRestoreOldStyle', 'hideEverythingExceptGivenElement', 'restoreHiddenElements', 'setLetterbox', 'softFullscreenResizeWebGLRenderTarget', 'doRequestFullscreen', 'fillPointerlockChangeEventData', 'registerPointerlockChangeEventCallback', 'registerPointerlockErrorEventCallback', 'requestPointerLock', 'fillVisibilityChangeEventData', 'registerVisibilityChangeEventCallback', 'registerTouchEventCallback', 'fillGamepadEventData', 'registerGamepadEventCallback', 'registerBeforeUnloadEventCallback', 'fillBatteryEventData', 'battery', 'registerBatteryEventCallback', 'setCanvasElementSize', 'getCanvasElementSize', 'jsStackTrace', 'getCallstack', 'convertPCtoSourceLocation', 'checkWasiClock', 'flush_NO_FILESYSTEM', 'wasiRightsToMuslOFlags', 'wasiOFlagsToMuslOFlags', 'createDyncallWrapper', 'safeSetTimeout', 'setImmediateWrapped', 'clearImmediateWrapped', 'polyfillSetImmediate', 'getPromise', 'makePromise', 'idsToPromises', 'makePromiseCallback', 'ExceptionInfo', 'findMatchingCatch', 'Browser_asyncPrepareDataCounter', 'setMainLoop', 'getSocketFromFD', 'getSocketAddress', 'FS_createPreloadedFile', 'FS_modeStringToFlags', 'FS_getMode', 'FS_stdin_getChar', 'FS_unlink', 'FS_createDataFile', 'FS_mkdirTree', '_setNetworkCallback', 'heapObjectForWebGLType', 'toTypedArrayIndex', 'webgl_enable_ANGLE_instanced_arrays', 'webgl_enable_OES_vertex_array_object', 'webgl_enable_WEBGL_draw_buffers', 'webgl_enable_WEBGL_multi_draw', 'emscriptenWebGLGet', 'computeUnpackAlignedImageSize', 'colorChannelsInGlTextureFormat', 'emscriptenWebGLGetTexPixelData', 'emscriptenWebGLGetUniform', 'webglGetUniformLocation', 'webglPrepareUniformLocationsBeforeFirstUse', 'webglGetLeftBracePos', 'emscriptenWebGLGetVertexAttrib', '__glGetActiveAttribOrUniform', 'writeGLArray', 'registerWebGlEventCallback', 'runAndAbortIfError', 'ALLOC_NORMAL', 'ALLOC_STACK', 'allocate', 'writeStringToMemory', 'writeAsciiToMemory', 'setErrNo', 'demangle', 'stackTrace'];
missingLibrarySymbols.forEach(missingLibrarySymbol);
var unexportedSymbols = ['run', 'addOnPreRun', 'addOnInit', 'addOnPreMain', 'addOnExit', 'addOnPostRun', 'addRunDependency', 'removeRunDependency', 'out', 'err', 'callMain', 'abort', 'wasmMemory', 'wasmExports', 'writeStackCookie', 'checkStackCookie', 'INT53_MAX', 'INT53_MIN', 'stackSave', 'stackRestore', 'stackAlloc', 'ptrToString', 'exitJS', 'getHeapMax', 'growMemory', 'ENV', 'MONTH_DAYS_REGULAR', 'MONTH_DAYS_LEAP', 'MONTH_DAYS_REGULAR_CUMULATIVE', 'MONTH_DAYS_LEAP_CUMULATIVE', 'ERRNO_CODES', 'DNS', 'Protocols', 'Sockets', 'timers', 'warnOnce', 'readEmAsmArgsArray', 'jstoi_s', 'getExecutableName', 'handleException', 'keepRuntimeAlive', 'wasmTable', 'noExitRuntime', 'getCFunc', 'ccall', 'freeTableIndexes', 'functionsInTableMap', 'setValue', 'getValue', 'PATH', 'PATH_FS', 'UTF8Decoder', 'UTF8ArrayToString', 'UTF8ToString', 'stringToUTF8Array', 'stringToUTF8', 'lengthBytesUTF8', 'stringToAscii', 'UTF16Decoder', 'stringToUTF8OnStack', 'writeArrayToMemory', 'JSEvents', 'specialHTMLTargets', 'findCanvasEventTarget', 'currentFullscreenStrategy', 'restoreOldWindowedStyle', 'UNWIND_CACHE', 'ExitStatus', 'getEnvStrings', 'promiseMap', 'uncaughtExceptionCount', 'exceptionLast', 'exceptionCaught', 'Browser', 'getPreloadedImageData__data', 'wget', 'SYSCALLS', 'preloadPlugins', 'FS_stdin_getChar_buffer', 'FS_createPath', 'FS_createDevice', 'FS_readFile', 'FS', 'FS_createLazyFile', 'MEMFS', 'TTY', 'PIPEFS', 'SOCKFS', 'tempFixedLengthArray', 'miniTempWebGLFloatBuffers', 'miniTempWebGLIntBuffers', 'GL', 'AL', 'GLUT', 'EGL', 'GLEW', 'IDBStore', 'SDL', 'SDL_gfx', 'allocateUTF8', 'allocateUTF8OnStack', 'print', 'printErr'];
unexportedSymbols.forEach(unexportedRuntimeSymbol);
var calledRun;
dependenciesFulfilled = function runCaller() {
  // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
  if (!calledRun) run();
  if (!calledRun) dependenciesFulfilled = runCaller; // try this again later, after new deps are fulfilled
};
function callMain() {
  let args = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];
  assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
  assert(__ATPRERUN__.length == 0, 'cannot call main when preRun functions remain to be called');
  var entryFunction = _main;
  args.unshift(thisProgram);
  var argc = args.length;
  var argv = stackAlloc((argc + 1) * 4);
  var argv_ptr = argv;
  args.forEach(arg => {
    HEAPU32[argv_ptr >> 2] = stringToUTF8OnStack(arg);
    argv_ptr += 4;
  });
  HEAPU32[argv_ptr >> 2] = 0;
  try {
    var ret = entryFunction(argc, argv);

    // if we're not running an evented main loop, it's time to exit
    exitJS(ret, /* implicit = */true);
    return ret;
  } catch (e) {
    return handleException(e);
  }
}
function stackCheckInit() {
  // This is normally called automatically during __wasm_call_ctors but need to
  // get these values before even running any of the ctors so we call it redundantly
  // here.
  _emscripten_stack_init();
  // TODO(sbc): Move writeStackCookie to native to to avoid this.
  writeStackCookie();
}
function run() {
  let args = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : arguments_;
  if (runDependencies > 0) {
    return;
  }
  stackCheckInit();
  preRun();

  // a preRun added a dependency, run will be called later
  if (runDependencies > 0) {
    return;
  }
  function doRun() {
    var _Module$onRuntimeInit, _Module5;
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    if (calledRun) return;
    calledRun = true;
    Module['calledRun'] = true;
    if (ABORT) return;
    initRuntime();
    preMain();
    (_Module$onRuntimeInit = (_Module5 = Module)['onRuntimeInitialized']) === null || _Module$onRuntimeInit === void 0 || _Module$onRuntimeInit.call(_Module5);
    if (shouldRunNow) callMain(args);
    postRun();
  }
  if (Module['setStatus']) {
    Module['setStatus']('Running...');
    setTimeout(function () {
      setTimeout(function () {
        Module['setStatus']('');
      }, 1);
      doRun();
    }, 1);
  } else {
    doRun();
  }
  checkStackCookie();
}
function checkUnflushedContent() {
  // Compiler settings do not allow exiting the runtime, so flushing
  // the streams is not possible. but in ASSERTIONS mode we check
  // if there was something to flush, and if so tell the user they
  // should request that the runtime be exitable.
  // Normally we would not even include flush() at all, but in ASSERTIONS
  // builds we do so just for this check, and here we see if there is any
  // content to flush, that is, we check if there would have been
  // something a non-ASSERTIONS build would have not seen.
  // How we flush the streams depends on whether we are in SYSCALLS_REQUIRE_FILESYSTEM=0
  // mode (which has its own special function for this; otherwise, all
  // the code is inside libc)
  var oldOut = out;
  var oldErr = err;
  var has = false;
  out = err = x => {
    has = true;
  };
  try {
    // it doesn't matter if it fails
    _fflush(0);
  } catch (e) {}
  out = oldOut;
  err = oldErr;
  if (has) {
    warnOnce('stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.');
    warnOnce('(this may also be due to not including full filesystem support - try building with -sFORCE_FILESYSTEM)');
  }
}
if (Module['preInit']) {
  if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
  while (Module['preInit'].length > 0) {
    Module['preInit'].pop()();
  }
}

// shouldRunNow refers to calling main(), not run().
var shouldRunNow = true;
if (Module['noInitialRun']) shouldRunNow = false;
run();

// end include: postamble.js
