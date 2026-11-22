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
  onscreen_canvas.onpointerdown = function (event) {
    // Arrange that all mouse (and pointer) events are sent to
    // this element until all buttons are released.  We can assume
    // that if we managed to receive a pointerdown event,
    // Element.setPointerCapture() is available.
    onscreen_canvas.setPointerCapture(event.pointerId);
  };
  onscreen_canvas.onmousedown = function (event) {
    if (event.button >= 3) return;
    var xy = canvas_mouse_coords(event, onscreen_canvas);
    var logbutton = event.button;
    if (event.shiftKey) logbutton = 1; // Shift-click overrides to middle button
    else if (event.ctrlKey) logbutton = 2; // Ctrl-click overrides to right button

    if (mousedown(xy.x, xy.y, logbutton)) event.preventDefault();
    button_phys2log[event.button] = logbutton;
    set_capture(onscreen_canvas, event);
  };
  var mousemove = Module.cwrap('mousemove', 'boolean', ['number', 'number', 'number']);
  onscreen_canvas.onmousemove = function (event) {
    var down = buttons_down();
    if (down) {
      var xy = canvas_mouse_coords(event, onscreen_canvas);
      if (mousemove(xy.x, xy.y, down)) event.preventDefault();
    }
  };
  var mouseup = Module.cwrap('mouseup', 'boolean', ['number', 'number', 'number']);
  onscreen_canvas.onmouseup = function (event) {
    if (event.button >= 3) return;
    if (button_phys2log[event.button] !== null) {
      var xy = canvas_mouse_coords(event, onscreen_canvas);
      if (mouseup(xy.x, xy.y, button_phys2log[event.button])) event.preventDefault();
      button_phys2log[event.button] = null;
    }
  };

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

var wasmBinary = Uint8Array.from(atob('AGFzbQEAAAAB2wIxYAN/f38AYAF/AGACf38Bf2ABfwF/YAN/f38Bf2ACf38AYAABf2AAAGAFf39/f38AYAR/f39/AX9gBH9/f38AYAV/fn5+fgBgBn9/f39/fwBgBH9/f38BfWAIf39/f39/f38AYAd/f39/f39/AGAGf39/f39/AX9gCH9/f39/f319AGAEf35+fwBgAn99AGAFf39/f38Bf2AHf39/f39/fwF/YAJ8fwF8YAZ/fH9/f38Bf2ACfn8Bf2AEfn5+fgF/YAABfGAGfX19fX9/AGALf39/f39/f39/f38AYAV/f39/fABgBH9/fHwBf2AEf399fwBgAn9/AX1gAXwAYAd/fX19fX1/AGABfwF8YAJ/fgBgAn5+AX9gA39+fgBgAn9/AX5gAn9/AXxgA35/fwF/YAF8AX5gBH9/f34BfmADf39+AGACf3wAYAJ+fgF8YAJ+fgF9YAN/fn8BfgLJCjQDZW52DV9fYXNzZXJ0X2ZhaWwACgNlbnYOanNfZ2V0X2RhdGVfNjQAAQNlbnYManNfZXJyb3JfYm94AAEDZW52E2pzX2RlYWN0aXZhdGVfdGltZXIABwNlbnYRanNfYWN0aXZhdGVfdGltZXIABwNlbnYcanNfY2FudmFzX2dldF9wcmVmZXJyZWRfc2l6ZQACA2Vudhlqc19nZXRfZGV2aWNlX3BpeGVsX3JhdGlvABoDZW52EmpzX2NhbnZhc19zZXRfc2l6ZQAAA2VudhFqc19kZWZhdWx0X2NvbG91cgABA2VudhNqc19lbmFibGVfdW5kb19yZWRvAAUDZW52FGpzX3VwZGF0ZV9rZXlfbGFiZWxzAAUDZW52FmpzX2dldF9zZWxlY3RlZF9wcmVzZXQABgNlbnYPanNfZm9jdXNfY2FudmFzAAcDZW52DmpzX2RpYWxvZ19pbml0AAEDZW52EGpzX2RpYWxvZ19zdHJpbmcAAANlbnYRanNfZGlhbG9nX2Jvb2xlYW4AAANlbnYRanNfZGlhbG9nX2Nob2ljZXMACgNlbnYQanNfZGlhbG9nX2xhdW5jaAAHA2VudhBqc19zZWxlY3RfcHJlc2V0AAEDZW52EWpzX2RpYWxvZ19jbGVhbnVwAAcDZW52EGpzX3NhdmVmaWxlX3JlYWQAAgNlbnYUanNfdXBkYXRlX3Blcm1hbGlua3MABQNlbnYOanNfaW5pdF9wdXp6bGUABwNlbnYNanNfbG9hZF9wcmVmcwABA2Vudhpqc19jYW52YXNfcmVtb3ZlX3N0YXR1c2JhcgAHA2Vudg1qc19hZGRfcHJlc2V0AAADZW52F2pzX3JlbW92ZV90eXBlX2Ryb3Bkb3duAAcDZW52FmpzX3JlbW92ZV9zb2x2ZV9idXR0b24ABwNlbnYNanNfc2V0X2NvbG91cgAFA2Vudgxqc19wb3N0X2luaXQABwNlbnYVanNfYWRkX3ByZXNldF9zdWJtZW51AAIDZW52DWpzX3NhdmVfcHJlZnMAAQNlbnYcanNfY2FudmFzX2ZpbmRfZm9udF9taWRwb2ludAACA2VudhNqc19jYW52YXNfZHJhd190ZXh0AA8DZW52E2pzX2NhbnZhc19kcmF3X2xpbmUAGwNlbnYVanNfY2FudmFzX25ld19ibGl0dGVyAAADZW52FmpzX2NhbnZhc19mcmVlX2JsaXR0ZXIAAQNlbnYTanNfY2FudmFzX2RyYXdfcmVjdAAMA2VudhNqc19jYW52YXNfZHJhd19wb2x5AAgDZW52FWpzX2NhbnZhc19kcmF3X2NpcmNsZQAMA2VudhVqc19jYW52YXNfZHJhd191cGRhdGUACANlbnYOanNfY2FudmFzX2NsaXAACANlbnYQanNfY2FudmFzX3VuY2xpcAABA2VudhRqc19jYW52YXNfc3RhcnRfZHJhdwABA2VudhJqc19jYW52YXNfZW5kX2RyYXcAAQNlbnYUanNfY2FudmFzX3N0YXR1c19iYXIABQNlbnYWanNfY2FudmFzX2JsaXR0ZXJfc2F2ZQAKA2VudhZqc19jYW52YXNfYmxpdHRlcl9sb2FkAAoDZW52FV9lbXNjcmlwdGVuX21lbWNweV9qcwAAFndhc2lfc25hcHNob3RfcHJldmlldzERZW52aXJvbl9zaXplc19nZXQAAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC2Vudmlyb25fZ2V0AAIDZW52FmVtc2NyaXB0ZW5fcmVzaXplX2hlYXAAAwOqAqgCBwYEBQIBAwMDAgkCAgIEAwEJAwMDBQMBAQAQAwQCCAoCAgURDw0NDgMcDgQODAgIAQEFAwECAwEDCQEdHgEFAQEBAQAAAQEFAQQBBAkEAgUAAAoDAwEJCQMDAwITAgYCAgACCQUFAwMABAIEAwMEAwIEFAQBAAICAh8IIAgVAAEBAAUFAAICAgEFBQEBIQcHBQUFBAcEBBACBQUBAQcBAQYBBgABBwQHBQQCBQEODAQFBCIjAwMEBAMBAwMHAwQEAQEGBwQEAgICAgICAgMEBAQCJAMGFgsSJQsmCgMMDycKKAMDAhYEFBUAAwopGBgIBBcFKgkEBCsDBgYGBwkDBAMCLAQEBAIGAwMEAQICBQsSGRkLLRMFBQYGEgsLCy4vBwYGBgEDBgMEBQFwAT8/BQcBAYICgIACBhIDfwFBgIAEC38BQQALfwFBAAsHyAQfBm1lbW9yeQIAEV9fd2FzbV9jYWxsX2N0b3JzADQZX19pbmRpcmVjdF9mdW5jdGlvbl90YWJsZQEABm1hbGxvYwC9AgRmcmVlAL8CDnRpbWVyX2NhbGxiYWNrAMEBDnJlc2NhbGVfcHV6emxlAMIBDXJlc2l6ZV9wdXp6bGUAxAETcmVzdG9yZV9wdXp6bGVfc2l6ZQDFAQltb3VzZWRvd24AxwEHbW91c2V1cADJAQltb3VzZW1vdmUAygEDa2V5AMsBD2RsZ19yZXR1cm5fc3ZhbADNAQ9kbGdfcmV0dXJuX2l2YWwAzgEHY29tbWFuZADPAQ9nZXRfdGV4dF9mb3JtYXQA1AEQZnJlZV90ZXh0X2Zvcm1hdADVAQ1nZXRfc2F2ZV9maWxlANYBDmZyZWVfc2F2ZV9maWxlANgBCWxvYWRfZ2FtZQDZARNwcmVmc19sb2FkX2NhbGxiYWNrANwBEF9fbWFpbl9hcmdjX2FyZ3YA3gEGZmZsdXNoANsCFWVtc2NyaXB0ZW5fc3RhY2tfaW5pdADUAhllbXNjcmlwdGVuX3N0YWNrX2dldF9mcmVlANUCGWVtc2NyaXB0ZW5fc3RhY2tfZ2V0X2Jhc2UA1gIYZW1zY3JpcHRlbl9zdGFja19nZXRfZW5kANcCGV9lbXNjcmlwdGVuX3N0YWNrX3Jlc3RvcmUA2AIXX2Vtc2NyaXB0ZW5fc3RhY2tfYWxsb2MA2QIcZW1zY3JpcHRlbl9zdGFja19nZXRfY3VycmVudADaAglTAQBBAQs+NTY3ODk6Ozw9PkFCQ0RFRkdISUpMTU5RUlNUVVZXWVpbXHd/pwHXAdoB3QHgAeEBJeIBJico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IQIMAQsgACECA0AgAiABLQAAOgAAIAIgAS0AAToAASACIAEtAAI6AAIgAiABLQADOgADIAFBBGohASACQQRqIgIgBE0NAAsLAkAgAiADTw0AA0AgAiABLQAAOgAAIAFBAWohASACQQFqIgIgA0cNAAsLIAAL8gICA38BfgJAIAJFDQAgACABOgAAIAAgAmoiA0F/aiABOgAAIAJBA0kNACAAIAE6AAIgACABOgABIANBfWogAToAACADQX5qIAE6AAAgAkEHSQ0AIAAgAToAAyADQXxqIAE6AAAgAkEJSQ0AIABBACAAa0EDcSIEaiIDIAFB/wFxQYGChAhsIgE2AgAgAyACIARrQXxxIgRqIgJBfGogATYCACAEQQlJDQAgAyABNgIIIAMgATYCBCACQXhqIAE2AgAgAkF0aiABNgIAIARBGUkNACADIAE2AhggAyABNgIUIAMgATYCECADIAE2AgwgAkFwaiABNgIAIAJBbGogATYCACACQWhqIAE2AgAgAkFkaiABNgIAIAQgA0EEcUEYciIFayICQSBJDQAgAa1CgYCAgBB+IQYgAyAFaiEBA0AgASAGNwMYIAEgBjcDECABIAY3AwggASAGNwMAIAFBIGohASACQWBqIgJBH0sNAAsLIAALBABBAQsCAAuBAQECfyAAIAAoAkgiAUF/aiABcjYCSAJAIAAoAhQgACgCHEYNACAAQQBBACAAKAIkEQQAGgsgAEEANgIcIABCADcDEAJAIAAoAgAiAUEEcUUNACAAIAFBIHI2AgBBfw8LIAAgACgCLCAAKAIwaiICNgIIIAAgAjYCBCABQRt0QR91C0EBAn8jAEEQayIBJABBfyECAkAgABDuAQ0AIAAgAUEPakEBIAAoAiARBABBAUcNACABLQAPIQILIAFBEGokACACC30BAn8jAEEQayIAJAACQCAAQQxqIABBCGoQMQ0AQQAgACgCDEECdEEEahC9AiIBNgLQrgQgAUUNAAJAIAAoAggQvQIiAUUNAEEAKALQrgQgACgCDEECdGpBADYCAEEAKALQrgQgARAyRQ0BC0EAQQA2AtCuBAsgAEEQaiQAC4gBAQR/AkAgAEE9EPwBIgEgAEcNAEEADwtBACECAkAgACABIABrIgNqLQAADQBBACgC0K4EIgFFDQAgASgCACIERQ0AAkADQAJAIAAgBCAD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IANBgIABSA0AIARBIGogASACQgBCgICAgICAgP//ABDPAiAEQSBqQQhqKQMAIQIgBCkDICEBAkAgA0H//wFPDQAgA0GBgH9qIQMMAgsgBEEQaiABIAJCAEKAgICAgICA//8AEM8CIANB/f8CIANB/f8CSRtBgoB+aiEDIARBEGpBCGopAwAhAiAEKQMQIQEMAQsgA0GBgH9KDQAgBEHAAGogASACQgBCgICAgICAgDkQzwIgBEHAAGpBCGopAwAhAiAEKQNAIQECQCADQfSAfk0NACADQY3/AGohAwwBCyAEQTBqIAEgAkIAQoCAgICAgIA5EM8CIANB6IF9IANB6IF9SxtBmv4BaiEDIARBMGpBCGopAwAhAiAEKQMwIQELIAQgASACQgAgA0H//wBqrUIwhhDPAiAAIARBCGopAwA3AwggACAEKQMANwMAIARB0ABqJAALSwIBfgJ/IAFC////////P4MhAgJAAkAgAUIwiKdB//8BcSIDQf//AUYNAEEEIQQgAw0BQQJBAyACIACEUBsPCyACIACEUCEECyAEC9IGAgR/A34jAEGAAWsiBSQAAkACQAJAIAMgBEIAQgAQxQJFDQAgAyAEEIwCRQ0AIAJCMIinIgZB//8BcSIHQf//AUcNAQsgBUEQaiABIAIgAyAEEM8CIAUgBSkDECIEIAVBEGpBCGopAwAiAyAEIAMQxwIgBUEIaikDACECIAUpAwAhBAwBCwJAIAEgAkL///////////8AgyIJIAMgBEL///////////8AgyIKEMUCQQBKDQACQCABIAkgAyAKEMUCRQ0AIAEhBAwCCyAFQfAAaiABIAJCAEIAEM8CIAVB+ABqKQMAIQIgBSkDcCEEDAELIARCMIinQf//AXEhCAJAAkAgB0UNACABIQQMAQsgBUHgAGogASAJQgBCgICAgICAwLvAABDPAiAFQegAaikDACIJQjCIp0GIf2ohByAFKQNgIQQLAkAgCA0AIAVB0ABqIAMgCkIAQoCAgICAgMC7wAAQzwIgBUHYAGopAwAiCkIwiKdBiH9qIQggBSkDUCEDCyAKQv///////z+DQoCAgICAgMAAhCELIAlC////////P4NCgICAgICAwACEIQkCQCAHIAhMDQADQAJAAkAgCSALfSAEIANUrX0iCkIAUw0AAkAgCiAEIAN9IgSEQgBS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BikDoAEgBkGgAWpBCGopAwBCf0L///////+///8AEM8CIAZBgAFqIAYpA5ABIAZBkAFqQQhqKQMAQn9C////////v///ABDPAiAGQYABakEIaikDACETIAYpA4ABIRAMAQsCQCATIANBnn5qrFMNAAJAIApBf0wNAANAIAZBoANqIBAgEUIAQoCAgICAgMD/v38QwwIgECARQgBCgICAgICAgP8/EMYCIQcgBkGQA2ogECARIAYpA6ADIBAgB0F/SiIHGyAGQaADakEIaikDACARIAcbEMMCIApBAXQiASAHciEKIBNCf3whEyAGQZADakEIaikDACERIAYpA5ADIRAgAUF/Sg0ACwsCQAJAIBMgA6x9QiB8Ig6nIgdBACAHQQBKGyACIA4gAq1TGyIHQfEASA0AIAZBgANqIAQQygIgBkGIA2opAwAhDkIAIQ8gBikDgAMhEkIAIRQMAQsgBkHgAmpEAAAAAAAA8D9BkAEgB2sQiQIQyAIgBkHQAmogBBDKAiAGQfACaiAGKQPgAiAGQeACakEIaikDACAGKQPQAiISIAZB0AJqQQhqKQMAIg4QigIgBkHwAmpBCGopAwAhFCAGKQPwAiEPCyAGQcACaiAKIApBAXFFIAdBIEggECARQgBCABDFAkEAR3FxIgdyEMsCIAZBsAJqIBIgDiAGKQPAAiAGQcACakEIaikDABDPAiAGQZACaiAGKQOwAiAGQbACakEIaikDACAPIBQQwwIgBkGgAmogEiAOQgAgECAHG0IAIBEgBxsQzwIgBkGAAmogBikDoAIgBkGgAmpBCGopAwAgBikDkAIgBkGQAmpBCGopAwAQwwIgBkHwAWogBikDgAIgBkGAAmpBCGopAwAgDyAUENECAkAgBikD8AEiECAGQfABakEIaikDACIRQgBCABDFAg0AEIgCQcQANgIACyAGQeABaiAQIBEgE6cQiwIgBkHgAWpBCGopAwAhEyAGKQPgASEQDAELEIgCQcQANgIAIAZB0AFqIAQQygIgBkHAAWogBikD0AEgBkHQAWpBCGopAwBCAEKAgICAgIDAABDPAiAGQbABaiAGKQPAASAGQcABakEIaikDAEIAQoCAgICAgMAAEM8CIAZBsAFqQQhqKQMAIRMgBikDsAEhEAsgACAQNwMAIAAgEzcDCCAGQbADaiQAC/ofAwt/Bn4B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FCAEIAI2AhgLIAEgA08NACADKAIEIgRBAXFFDQACQAJAAkACQAJAIARBAnENAAJAIANBACgCuLAERw0AQQAgATYCuLAEQQBBACgCrLAEIABqIgA2AqywBCABIABBAXI2AgQgAUEAKAK0sARHDQZBAEEANgKosARBAEEANgK0sAQPCwJAIANBACgCtLAERw0AQQAgATYCtLAEQQBBACgCqLAEIABqIgA2AqiwBCABIABBAXI2AgQgASAAaiAANgIADwsgBEF4cSAAaiEAIAMoAgwhAgJAIARB/wFLDQACQCACIAMoAggiBUcNAEEAQQAoAqCwBEF+IARBA3Z3cTYCoLAEDAULIAUgAjYCDCACIAU2AggMBAsgAygCGCEGAkAgAiADRg0AIAMoAggiBCACNgIMIAIgBDYCCAwDCwJAAkAgAygCFCIERQ0AIANBFGohBQwBCyADKAIQIgRFDQIgA0EQaiEFCwNAIAUhByAEIgJBFGohBSACKAIUIgQNACACQRBqIQUgAigCECIEDQALIAdBADYCAAwCCyADIARBfnE2AgQgASAAQQFyNgIEIAEgAGogADYCAAwDC0EAIQILIAZFDQACQAJAIAMgAygCHCIFQQJ0QdCyBGoiBCgCAEcNACAEIAI2AgAgAg0BQQBBACgCpLAEQX4gBXdxNgKksAQMAgsgBkEQQRQgBigCECADRhtqIAI2AgAgAkUNAQsgAiAGNgIYAkAgAygCECIERQ0AIAIgBDYCECAEIAI2AhgLIAMoAhQiBEUNACACIAQ2AhQgBCACNgIYCyABIABBAXI2AgQgASAAaiAANgIAIAFBACgCtLAERw0AQQAgADYCqLAEDwsCQCAAQf8BSw0AIABBeHFByLAEaiECAkACQEEAKAKgsAQiBEEBIABBA3Z0IgBxDQBBACAEIAByNgKgsAQgAiEADAELIAIoAgghAAsgAiABNgIIIAAgATYCDCABIAI2AgwgASAANgIIDwtBHyECAkAgAEH///8HSw0AIABBJiAAQQh2ZyICa3ZBAXEgAkEBdGtBPmohAgsgASACNgIcIAFCADcCECACQQJ0QdCyBGohAwJAAkACQAJAQQAoAqSwBCIEQQEgAnQiBXENAEEAIAQgBXI2AqSwBEEIIQBBGCECIAMhBQwBCyAAQQBBGSACQQF2ayACQR9GG3QhAiADKAIA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IAAgADYCCA8LIAQoAggiASAANgIMIAQgADYCCCAAQQA2AhggACAENgIMIAAgATYCCAsL6goCBH8EfiMAQfAAayIFJAAgBEL///////////8AgyEJAkACQAJAIAFQIgYgAkL///////////8AgyIKQoCAgICAgMCAgH98QoCAgICAgMCAgH9UIApQGw0AIANCAFIgCUKAgICAgIDAgIB/fCILQoCAgICAgMCAgH9WIAtCgICAgICAwICAf1EbDQELAkAgBiAKQoCAgICAgMD//wBUIApCgICAgICAwP//AFEbDQAgAkKAgICAgIAghCEEIAEhAwwCCwJAIANQIAlCgICAgICAwP//AFQgCUKAgICAgIDA//8AURsNACAEQoCAgICAgCCEIQQMAgsCQCABIApCgICAgICAwP//AIWEQgBSDQBCgICAgICA4P//ACACIAMgAYUgBCAChUKAgICAgICAgIB/hYRQIgYbIQRCACABIAYbIQMMAgsgAyAJQoCAgICAgMD//wCFhFANAQJAIAEgCoRCAFINACADIAmEQgBSDQIgAyABgyEDIAQgAoMhBAwCCyADIAmEUEUNACABIQMgAiEEDAELIAMgASADIAFWIAkgClYgCSAKURsiBxshCSAEIAIgBxsiC0L///////8/gyEKIAIgBCAHGyIMQjCIp0H//wFxIQgCQCALQjCIp0H//wFxIgYNACAFQeAAaiAJIAogCSAKIApQIgYbeSAGQQZ0rXynIgZBcWoQxAJBECAGayEGIAVB6ABqKQMAIQogBSkDYCEJCyABIAMgBxshAyAMQv///////z+DIQECQCAIDQAgBUHQAGogAyABIAMgASABUCIHG3kgB0EGdK18pyIHQXFqEMQCQRAgB2shCCAFQdgAaikDACEBIAUpA1AhAwsgAUIDhiADQj2IhEKAgICAgICABIQhASAKQgOGIAlCPYiEIQwgA0IDhiEKIAQgAoUhAwJAIAYgCEYNAAJAIAYgCGsiB0H/AE0NAEIAIQFCASEKDAELIAVBwABqIAogAUGAASAHaxDEAiAFQTBqIAogASAHEM4CIAUpAzAgBSkDQCAFQcAAakEIaikDAIRCAFKthCEKIAVBMGpBCGopAwAhAQsgDEKAgICAgICABIQhDCAJQgOGIQkCQAJAIANCf1UNAEIAIQNCACEEIAkgCoUgDCABhYRQDQIgCSAKfSECIAwgAX0gCSAKVK19IgRC/////////wNWDQEgBUEgaiACIAQgAiAEIARQIgcbeSAHQQZ0rXynQXRqIgcQxAIgBiAHayEGIAVBKGopAwAhBCAFKQMgIQIMAQsgASAMfCAKIAl8IgIgClStfCIEQoCAgICAgIAIg1ANACACQgGIIARCP4aEIApCAYOEIQIgBkEBaiEGIARCAYghBAsgC0KAgICAgICAgIB/gyEKAkAgBkH//wFIDQAgCkKAgICAgIDA//8AhCEEQgAhAwwBC0EAIQcCQAJAIAZBAEwNACAGIQcMAQsgBUEQaiACIAQgBkH/AGoQxAIgBSACIARBASAGaxDOAiAFKQMAIAUpAxAgBUEQakEIaikDAIRCAFKthCECIAVBCGopAwAhBAsgAkIDiCAEQj2GhCEDIAetQjCGIARCA4hC////////P4OEIAqEIQQgAqdBB3EhBgJAAkACQAJAAkAQzAIOAwABAgMLAkAgBkEERg0AIAQgAyAGQQRLrXwiCiADVK18IQQgCiEDDAMLIAQgAyADQgGDfCIKIANUrXwhBCAKIQMMAwsgBCADIApCAFIgBkEAR3GtfCIKIANUrXwhBCAKIQMMAQsgBCADIApQIAZBAEdxrXwiCiADVK18IQQgCiEDCyAGRQ0BCxDNAhoLIAAgAzcDACAAIAQ3AwggBUHwAGokAAtTAQF+AkACQCADQcAAcUUNACABIANBQGqthiECQgAhAQwBCyADRQ0AIAFBwAAgA2utiCACIAOtIgSGhCECIAEgBIYhAQsgACABNwMAIAAgAjcDCAvmAQIBfwJ+QQEhBAJAIABCAFIgAUL///////////8AgyIFQoCAgICAgMD//wBWIAVCgICAgICAwP//AFEbDQAgAkIAUiADQv///////////wCDIgZCgICAgICAwP//AFYgBkKAgICAgIDA//8AURsNAAJAIAIgAIQgBiAFhIRQRQ0AQQAPCwJAIAMgAYNCAFMNAAJAIAAgAlQgASADUyABIANRG0UNAEF/DwsgACAChSABIAOFhEIAUg8LAkAgACACViABIANVIAEgA1EbRQ0AQX8PCyAAIAKFIAEgA4WEQgBSIQQLIAQL2AECAX8CfkF/IQQCQCAAQgBSIAFC////////////AIMiBUKAgICAgIDA//8AViAFQoCAgICAgMD//wBRGw0AIAJCAFIgA0L///////////8AgyIGQoCAgICAgMD//wBWIAZCgICAgICAwP//AFEbDQACQCACIACEIAYgBYSEUEUNAEEADwsCQCADIAGDQgBTDQAgACACVCABIANTIAEgA1EbDQEgACAChSABIAOFhEIAUg8LIAAgAlYgASADVSABIANRGw0AIAAgAoUgASADhYRCAFIhBAsgBAvnEAIFfw9+IwBB0AJrIgUkACAEQv///////z+DIQogAkL///////8/gyELIAQgAoVCgICAgICAgICAf4MhDCAEQjCIp0H//wFxIQYCQAJAAkAgAkIwiKdB//8BcSIHQYGAfmpBgoB+SQ0AQQAhCCAGQYGAfmpBgYB+Sw0BCwJAIAFQIAJC////////////AIMiDUKAgICAgIDA//8AVCANQoCAgICAgMD//wBRGw0AIAJCgICAgICAIIQhDAwCCwJAIANQIARC////////////AIMiAkKAgICAgIDA//8AVCACQoCAgICAgMD//wBRGw0AIARCgICAgICAIIQhDCADIQEMAgsCQCABIA1CgICAgICAwP//AIWEQgBSDQACQCADIAJCgICAgICAwP//AIWEUEUNAEIAIQFCgICAgICA4P//ACEMDAMLIAxCgICAgICAwP//AIQhDEIAIQEMAgsCQCADIAJCgICAgICAwP//AIWEQgBSDQBCACEBDAILAkAgASANhEIAUg0AQoCAgICAgOD//wAgDCADIAKEUBshDEIAIQEMAgsCQCADIAKEQgBSDQAgDEKAgICAgIDA//8AhCEMQgAhAQwCC0EAIQgCQCANQv///////z9WDQAgBUHAAmogASALIAEgCyALUCIIG3kgCEEGdK18pyIIQXFqEMQCQRAgCGshCCAFQcgCaikDACELIAUpA8ACIQELIAJC////////P1YNACAFQbACaiADIAogAyAKIApQIgkbeSAJQQZ0rXynIglBcWoQxAIgCSAIakFwaiEIIAVBuAJqKQMAIQogBSkDsAIhAwsgBUGgAmogA0IxiCAKQoCAgICAgMAAhCIOQg+GhCICQgBCgICAgLDmvIL1ACACfSIEQgAQ0AIgBUGQAmpCACAFQaACakEIaikDAH1CACAEQgAQ0AIgBUGAAmogBSkDkAJCP4ggBUGQAmpB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QgAhBwwBCyACIAStQgAgBGciBEHRAGoQxAJBif8AIARrIQQgAkEIaikDAEKAgICAgIDAAIUhByACKQMAIQgLIAAgCDcDACAAIAStQjCGIANBH3atQj+GhCAHhDcDCCACQRBqJAALjQECAn8CfiMAQRBrIgIkAAJAAkAgAQ0AQgAhBEIAIQUMAQsgAiABIAFBH3UiA3MgA2siA61CACADZyIDQdEAahDEAiACQQhqKQMAQoCAgICAgMAAhUGegAEgA2utQjCGfCABQYCAgIB4ca1CIIaEIQUgAikDACEECyAAIAQ3AwAgACAFNwMIIAJBEGokAAt1AgF/An4jAEEQayICJAACQAJAIAENAEIAIQNCACEEDAELIAIgAa1CAEHwACABZyIBQR9zaxDEAiACQQhqKQMAQoCAgICAgMAAhUGegAEgAWutQjCGfCEEIAIpAwAhAwsgACADNwMAIAAgBDcDCCACQRBqJAALBABBAAsEAEEAC1MBAX4CQAJAIANBwABxRQ0AIAIgA0FAaq2IIQFCACECDAELIANFDQAgAkHAACADa62GIAEgA60iBIiEIQEgAiAEiCECCyAAIAE3AwAgACACNwMIC5oLAgV/D34jAEHgAGsiBSQAIARC////////P4MhCiAEIAKFQoCAgICAgICAgH+DIQsgAkL///////8/gyIMQiCIIQ0gBEIwiKdB//8BcSEGAkACQAJAIAJCMIinQf//AXEiB0GBgH5qQYKAfkkNAEEAIQggBkGBgH5qQYGAfksNAQsCQCABUCACQv///////////wCDIg5CgICAgICAwP//AFQgDkKAgICAgIDA//8AURsNACACQoCAgICAgCCEIQsMAgsCQCADUCAEQv///////////wCDIgJCgICAgICAwP//AFQgAkKAgICAgIDA//8AURsNACAEQoCAgICAgCCEIQsgAyEBDAILAkAgASAOQoCAgICAgMD//wCFhEIAUg0AAkAgAyAChFBFDQBCgICAgICA4P//ACELQgAhAQwDCyALQoCAgICAgMD//wCEIQtCACEBDAILAkAgAyACQoCAgICAgMD//wCFhEIAUg0AIAEgDoQhAkIAIQECQCACUEUNAEKAgICAgIDg//8AIQsMAwsgC0KAgICAgIDA//8AhCELDAILAkAgASAOhEIAUg0AQgAhAQwCCwJAIAMgAoRCAFINAEIAIQEMAgtBACEIAkAgDkL///////8/Vg0AIAVB0ABqIAEgDCABIAwgDFAiCBt5IAhBBnStfKciCEFxahDEAkEQIAhrIQggBUHYAGopAwAiDEIgiCENIAUpA1AhAQsgAkL///////8/Vg0AIAVBwABqIAMgCiADIAogClAiCRt5IAlBBnStfKciCUFxahDEAiAIIAlrQRBqIQggBUHIAGopAwAhCiAFKQNAIQMLIANCD4YiDkKAgP7/D4MiAiABQiCIIgR+Ig8gDkIgiCIOIAFC/////w+DIgF+fCIQQiCGIhEgAiABfnwiEiARVK0gAiAMQv////8PgyIMfiITIA4gBH58IhEgA0IxiCAKQg+GIhSEQv////8PgyIDIAF+fCIVIBBCIIggECAPVK1CIIaEfCIQIAIgDUKAgASEIgp+IhYgDiAMfnwiDSAUQiCIQoCAgIAIhCICIAF+fCIPIAMgBH58IhRCIIZ8Ihd8IQEgByAGaiAIakGBgH9qIQYCQAJAIAIgBH4iGCAOIAp+fCIEIBhUrSAEIAMgDH58Ig4gBFStfCACIAp+fCAOIBEgE1StIBUgEVStfHwiBCAOVK18IAMgCn4iAyACIAx+fCICIANUrUIghiACQiCIhHwgBCACQiCGfCICIARUrXwgAiAUQiCIIA0gFlStIA8gDVStfCAUIA9UrXxCIIaEfCIEIAJUrXwgBCAQIBVUrSAXIBBUrXx8IgIgBFStfCIEQoCAgICAgMAAg1ANACAGQQFqIQYMAQsgEkI/iCEDIARCAYYgAkI/iIQhBCACQgGGIAFCP4iEIQIgEkIBhiESIAMgAUIBhoQhAQsCQCAGQf//AUgNACALQoCAgICAgMD//wCEIQtCACEBDAELAkACQCAGQQBKDQACQEEBIAZrIgdB/wBLDQAgBUEwaiASIAEgBkH/AGoiBhDEAiAFQSBqIAIgBCAGEMQCIAVBEGogEiABIAcQzgIgBSACIAQgBxDOAiAFKQMgIAUpAxCEIAUpAzAgBUEwakEIaikDAIRCAFKthCESIAVBIGpBCGopAwAgBUEQakEIaikDAIQhASAFQQhqKQMAIQQgBSkDACECDAILQgAhAQwCCyAGrUIwhiAEQv///////z+DhCEECyAEIAuEIQsCQCASUCABQn9VIAFCgICAgICAgICAf1EbDQAgCyACQgF8IgFQrXwhCwwBCwJAIBIgAUKAgICAgICAgIB/hYRCAFENACACIQEMAQsgCyACIAJCAYN8IgEgAlStfCELCyAAIAE3AwAgACALNwMIIAVB4ABqJAALdQEBfiAAIAQgAX4gAiADfnwgA0IgiCICIAFCIIgiBH58IANC/////w+DIgMgAUL/////D4MiAX4iBUIgiCADIAR+fCIDQiCIfCADQv////8PgyACIAF+fCIBQiCIfDcDCCAAIAFCIIYgBUL/////D4OENwMAC0gBAX8jAEEQayIFJAAgBSABIAIgAyAEQoCAgICAgICAgH+FEMMCIAUpAwAhBCAAIAVBCGopAwA3AwggACAENwMAIAVBEGokAAuQBAIFfwJ+IwBBIGsiAiQAIAFC////////P4MhBwJAAkAgAUIwiEL//wGDIginIgNB/4d/akH9D0sNACAAQjyIIAdCBIaEIQcgA0GAiH9qrSEIAkACQCAAQv//////////D4MiAEKBgICAgICAgAhUDQAgB0IBfCEHDAELIABCgICAgICAgIAIUg0AIAdCAYMgB3whBwtCACAHIAdC/////////wdWIgMbIQAgA60gCHwhBwwBCwJAIAAgB4RQDQAgCEL//wFSDQAgAEI8iCAHQgSGhEKAgICAgICABIQhAEL/DyEHDAELAkAgA0H+hwFNDQBC/w8hB0IAIQAMAQsCQEGA+ABBgfgAIAhQIgQbIgUgA2siBkHwAEwNAEIAIQBCACEHDAELIAJBEGogACAHIAdCgICAgICAwACEIAQbIgdBgAEgBmsQxAIgAiAAIAcgBhDOAiACKQMAIgdCPIggAkEIaikDAEIEhoQhAAJAAkAgB0L//////////w+DIAUgA0cgAikDECACQRBqQQhqKQMAhEIAUnGthCIHQoGAgICAgICACFQNACAAQgF8IQAMAQsgB0KAgICAgICAgAhSDQAgAEIBgyAAfCEACyAAQoCAgICAgIAIhSAAIABC/////////wdWIgMbIQAgA60hBwsgAkEgaiQAIAdCNIYgAUKAgICAgICAgIB/g4QgAIS/C/EDAgV/An4jAEEgayICJAAgAUL///////8/gyEHAkACQCABQjCIQv//AYMiCKciA0H/gH9qQf0BSw0AIAdCGYinIQQCQAJAIABQIAFC////D4MiB0KAgIAIVCAHQoCAgAhRGw0AIARBAWohBAwBCyAAIAdCgICACIWEQgBSDQAgBEEBcSAEaiEEC0EAIAQgBEH///8DSyIFGyEEQYGBf0GAgX8gBRsgA2ohAwwBCwJAIAAgB4RQDQAgCEL//wFSDQAgB0IZiKdBgICAAnIhBEH/ASEDDAELAkAgA0H+gAFNDQBB/wEhA0EAIQQMAQsCQEGA/wBBgf8AIAhQIgUbIgYgA2siBEHwAEwNAEEAIQRBACEDDAELIAJBEGogACAHIAdCgICAgICAwACEIAUbIgdBgAEgBGsQxAIgAiAAIAcgBBDOAiACQQhqKQMAIgBCGYinIQQCQAJAIAIpAwAgBiADRyACKQMQIAJBEGpBCGopAwCEQgBSca2EIgdQIABC////D4MiAEKAgIAIVCAAQoCAgAhRGw0AIARBAWohBAwBCyAHIABCgICACIWEQgBSDQAgBEEBcSAEaiEECyAEQYCAgARzIAQgBEH///8DSyIDGyEECyACQSBqJAAgA0EXdCABQiCIp0GAgICAeHFyIARyvgsSAEGAgAQkAkEAQQ9qQXBxJAELBwAjACMBawsEACMCCwQAIwELBgAgACQACxIBAn8jACAAa0FwcSIBJAAgAQsEACMAC8MCAQN/AkAgAA0AQQAhAQJAQQAoAsyuBEUNAEEAKALMrgQQ2wIhAQsCQEEAKALMrgRFDQBBACgCzK4EENsCIAFyIQELAkAQ9gEoAgAiAEUNAANAQQAhAgJAIAAoAkxBAEgNACAAEOwBIQILAkAgACgCFCAAKAIcRg0AIAAQ2wIgAXIhAQsCQCACRQ0AIAAQ7QELIAAoAjgiAA0ACwsQ9wEgAQ8LAkACQCAAKAJMQQBODQBBASECDAELIAAQ7AFFIQILAkACQAJAIAAoAhQgACgCHEYNACAAQQBBACAAKAIkEQQAGiAAKAIUDQBBfyEBIAJFDQEMAgsCQCAAKAIEIgEgACgCCCIDRg0AIAAgASADa6xBASAAKAIoETAAGgtBACEBIABBADYCHCAAQgA3AxAgAEIANwIEIAINAQsgABDtAQsgAQsLtC4CAEGAgAQLnC56AHBlcm1fcGFyaXR5KHRpbGVzLCBuKSA9PSBwYXJpdHkAaW5maW5pdHkAbnggIT0gdHggfHwgbnkgIT0gdHkAb3V0IG9mIG1lbW9yeQB0eSA8PSBueQBTYXZlZCBkYXRhIGVuZGVkIHVuZXhwZWN0ZWRseQB0eSA8PSBneQBueCAhPSBneCB8fCBueSAhPSBneQBtaWRlbmRfcmVhbGx5X3Byb2Nlc3Nfa2V5AGR4IHx8IGR5AG91dF95AG91dF94ACMlMDJ4JTAyeCUwMngAJTJ4JTJ4JTJ4AC0rICAgMFgweAAtMFgrMFggMFgtMHgrMHggMHgAZ2FtZV9yZWRyYXcAbWlkZW5kX3JlZHJhdwAhbWUtPm91cmdhbWUtPnByZXNldF9tZW51AGNvbXB1dGVfaGludABIZWlnaHQAQXJyb3dSaWdodABBcnJvd0xlZnQAU29mdExlZnQAZ2FtZV90ZXh0X2Zvcm1hdABDYW5ub3QgaGFuZGxlIHRoaXMgdmVyc2lvbiBvZiB0aGUgc2F2ZWQgZ2FtZSBmaWxlIGZvcm1hdABTZW5zZSBvZiBhcnJvdyBrZXlzAG9uZS1rZXktc2hvcnRjdXRzAGkgPCBucHJlc2V0cwBtaWRlbmRfZ2V0X3ByZXNldHMAbWlkZW5kX2NvbG91cnMAZW5jb2RlX3BhcmFtcwBVbmRvaW5nIHRoaXMgbmV3LWdhbWUgb3BlcmF0aW9uIHdvdWxkIGNoYW5nZSBwYXJhbXMAbWlkZW5kX2FwcGx5X3ByZWZzAG1pZGVuZF9nZXRfcHJlZnMAc2F2ZV9wcmVmcwBtaWRlbmRfc2VyaWFsaXNlX3ByZWZzAHBvcyA8IG5fbWVfcHJlZnMAbWUtPnN0YXRlcG9zID49IDEgJiYgbWUtPnN0YXRlcG9zIDw9IG1lLT5uc3RhdGVzAGdvdHN0YXRlcyA8IGRhdGEubnN0YXRlcwAlcyBwcmVmZXJlbmNlcwBhcnJvdy1zZW1hbnRpY3MAJSpzACVzJWMlcwAlczolcwAlcyMlcwBwYXJzdHIAIWRlc2VyaWFsaXNlX2Vycm9yAEVudGVyAEV4cGVjdGVkIGNvbW1hIGFmdGVyIG51bWJlcgBTcGFjZWJhcgBzdGF0dXNfYmFyADp0aWxlOmdhcAA6TW92ZSB0aGUgdGlsZTpNb3ZlIHRoZSBnYXAAQXJyb3dVcABQYWdlVXAAISpwAFdpZHRoIGFuZCBoZWlnaHQgbXVzdCBib3RoIGJlIGF0IGxlYXN0IHR3bwByYW5kb21fdXB0bwBtaWRlbmRfdW5kbwBtaWRlbmRfcmVkbwBBcnJvd0Rvd24AUGFnZURvd24AU2ltb24gVGF0aGFtJ3MgUG9ydGFibGUgUHV6emxlIENvbGxlY3Rpb24AJXMgJXMgc2VsZWN0aW9uACVzIGNvbmZpZ3VyYXRpb24AVGhpcyBnYW1lIGRvZXMgbm90IHN1cHBvcnQgdGhlIFNvbHZlIG9wZXJhdGlvbgBJbnZhbGlkIHZhbHVlIGZvciBlbnVtZXJhdGlvbgBoZXgyYmluAHAgLSByZXQgPT0gbWF4bGVuAGxlbiA8IElOVF9NQVggLSBzZXItPmxlbgBnYW1lcy5maWZ0ZWVuAEZpZnRlZW4AbmFuAHJldC0+Z2FwX3BvcyA+PSAwICYmIHJldC0+Z2FwX3BvcyA8IHJldC0+bgBwID49IDAgJiYgcCA8IGZyb20tPm4AaiA8IG9sZHN0YXRlLT5uAHggPCBuAHJhbmRvbQBLZXlib2FyZCBzaG9ydGN1dHMgd2l0aG91dCBDdHJsAG1pZGVuZF9jdXJyZW50X2tleV9sYWJlbABEZWwAZGxnX3JldHVybl9zdmFsAGRsZ19yZXR1cm5faXZhbABtaWRlbmRfZGVzZXJpYWxpc2VfaW50ZXJuYWwAYXNzZXJ0X3ByaW50YWJsZV9hc2NpaQBXaWR0aABtb3Zlc3RyICYmICFtc2cAbWUtPmRyYXdpbmcAR2FtZSBkZXNjcmlwdGlvbiBpbiBzYXZlIGZpbGUgaXMgbWlzc2luZwBTaG9ydC10ZXJtIHBhcmFtZXRlcnMgaW4gc2F2ZSBmaWxlIGFyZSBtaXNzaW5nAExvbmctdGVybSBwYXJhbWV0ZXJzIGluIHNhdmUgZmlsZSBhcmUgbWlzc2luZwBOb3QgZW5vdWdoIG51bWJlcnMgaW4gc3RyaW5nAEV4Y2VzcyBqdW5rIGF0IGVuZCBvZiBzdHJpbmcAbWlkZW5kX2dldF9jb25maWcAY2ZnACVnAGluZgAwMTIzNDU2Nzg5YWJjZGVmAG5ld19zaXplID4gYnVmLT5zaXplAGJ1Zi0+bGVuIDwgYnVmLT5zaXplAGN0eC5wb3MgPT0gc2l6ZQBuZXh0X21vdmUAZXhlY3V0ZV9tb3ZlAFNhdmUgZmlsZSBjb250YWluZWQgYW4gaW52YWxpZCByZXN0YXJ0IG1vdmUAU2F2ZSBmaWxlIGNvbnRhaW5lZCBhbiBpbnZhbGlkIG1vdmUAbWlkZW5kX3NvbHZlAE5vIGdhbWUgc2V0IHVwIHRvIHNvbHZlAE51bWJlciBvZiBzdGF0ZXMgaW4gc2F2ZSBmaWxlIHdhcyBuZWdhdGl2ZQB0cnVlAG1pZGVuZF9zZXJpYWxpc2VfYnVmX3dyaXRlAERlbGV0ZQBmYWxzZQBtaWRlbmRfc2VyaWFsaXNlAEVzY2FwZQBIb21lAG1pZGVuZF9uZXdfZ2FtZQBtaWRlbmRfcmVzdGFydF9nYW1lAFNhdmUgZmlsZSBpcyBmcm9tIGEgZGlmZmVyZW50IGdhbWUAZHJpLT5tZQB3aW50aXRsZQBnZXRfc2F2ZV9maWxlAFBhcnRpYWwgbGluZSBhdCBlbmQgb2YgcHJlZmVyZW5jZXMgZmlsZQBObyBzdGF0ZSBjb3VudCBwcm92aWRlZCBpbiBzYXZlIGZpbGUAVHdvIHN0YXRlIGNvdW50cyBwcm92aWRlZCBpbiBzYXZlIGZpbGUATm8gZ2FtZSBwb3NpdGlvbiBwcm92aWRlZCBpbiBzYXZlIGZpbGUARm9yYmlkZGVuIGNoYXJhY3RlcnMgaW4gc2F2ZWQgZ2FtZSBmaWxlAERhdGEgd2FzIGluY29ycmVjdGx5IGZvcm1hdHRlZCBmb3IgYSBzYXZlZCBnYW1lIGZpbGUARGF0YSBkb2VzIG5vdCBhcHBlYXIgdG8gYmUgYSBzYXZlZCBnYW1lIGZpbGUAV2lkdGggdGltZXMgaGVpZ2h0IG11c3Qgbm90IGJlIHVucmVhc29uYWJseSBsYXJnZQBhbGxvY2F0aW9uIHRvbyBsYXJnZQBHYW1lIHBvc2l0aW9uIGluIHNhdmUgZmlsZSBpcyBvdXQgb2YgcmFuZ2UATnVtYmVyIG91dCBvZiByYW5nZQBOdW1iZXIgdXNlZCB0d2ljZQBCYWNrc3BhY2UARXhwZWN0ZWQgJz0nIGFmdGVyIGtleXdvcmQAYnVmZmVyX2FwcGVuZABjb21tYW5kAEVuZABHYW1lIHByaXZhdGUgZGVzY3JpcHRpb24gaW4gc2F2ZSBmaWxlIGlzIGludmFsaWQAR2FtZSBkZXNjcmlwdGlvbiBpbiBzYXZlIGZpbGUgaXMgaW52YWxpZABTaG9ydC10ZXJtIHBhcmFtZXRlcnMgaW4gc2F2ZSBmaWxlIGFyZSBpbnZhbGlkAExvbmctdGVybSBwYXJhbWV0ZXJzIGluIHNhdmUgZmlsZSBhcmUgaW52YWxpZABtaWRlbmRfZ2V0X2dhbWVfaWQAU29sdmUgb3BlcmF0aW9uIGZhaWxlZABjb3B5X2xlZnRfanVzdGlmaWVkAG1pZGVuZF9nZXRfcmFuZG9tX3NlZWQAR2FtZSByYW5kb20gc2VlZAAlKmQAJWR4JWQAJXNfQ09MT1VSXyVkAE0lZCwlZAAlc01vdmVzOiAlZABNb3ZlcyBzaW5jZSBhdXRvLXNvbHZlOiAlZABuZXdfZ2FtZV9kZXNjAG1lLT5kZXNjAC9wdXp6bGVzL2ZpZnRlZW4uYwAvcHV6emxlcy9yYW5kb20uYwAvcHV6emxlcy9kcmF3aW5nLmMAL3B1enpsZXMvbWlkZW5kLmMAL3B1enpsZXMvbWlzYy5jAC9wdXp6bGVzL2VtY2MuYwBqIDwgbiAmJiAhdXNlZFtqXQBaAHlZdFQAUkVTVEFSVAAlc19ERUZBVUxUACVzX1BSRVNFVFMAU1RBVEVQT1MAQ1BBUkFNUwBOU1RBVEVTAEZJRlRFRU5fSU5WRVJUX0NVUlNPUgBBVVhJTkZPAFZFUlNJT04ATkFOAFBVWlpMRVNfQUxMT1dfQ1VTVE9NAHMgIT0gTlVMTABtb3Zlc3RyICE9IE5VTEwAVUkASU5GADAuMEYgPD0gcmV0W2kqMyArIDJdICYmIHJldFtpKjMgKyAyXSA8PSAxLjBGADAuMEYgPD0gcmV0W2kqMyArIDFdICYmIHJldFtpKjMgKyAxXSA8PSAxLjBGADAuMEYgPD0gcmV0W2kqMyArIDBdICYmIHJldFtpKjMgKyAwXSA8PSAxLjBGACVzX1RJTEVTSVpFAE1PVkUAU09MVkUAbW92ZXN0ciAhPSBNT1ZFX1VJX1VQREFURQBUSU1FAG1lLT5zdGF0ZXNbaV0ubW92ZXR5cGUgIT0gTkVXR0FNRQBkYXRhLnN0YXRlc1tpXS5tb3ZldHlwZSAhPSBORVdHQU1FAFNBVkVGSUxFAEdhbWUgSUQASEVYU0VFRABQUklWREVTQwA9ACVzOiVkOgBsZW4gPD0gOABzW2ldID49IDMyICYmIHNbaV0gPCAxMjcA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/////////wABAgMEBQYHCAn/////////CgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiP///////8KCwwNDg8QERITFBUWFxgZGhscHR4fICEiI/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AAQIEBwMGBQAAAAAAAAACAADAAwAAwAQAAMAFAADABgAAwAcAAMAIAADACQAAwAoAAMALAADADAAAwA0AAMAOAADADwAAwBAAAMARAADAEgAAwBMAAMAUAADAFQAAwBYAAMAXAADAGAAAwBkAAMAaAADAGwAAwBwAAMAdAADAHgAAwB8AAMAAAACzAQAAwwIAAMMDAADDBAAAwwUAAMMGAADDBwAAwwgAAMMJAADDCgAAwwsAAMMMAADDDQAA0w4AAMMPAADDAAAMuwEADMMCAAzDAwAMwwQADNsAQZyuBAsI/////xAaAQAAPw90YXJnZXRfZmVhdHVyZXMDKw9tdXRhYmxlLWdsb2JhbHMrD3JlZmVyZW5jZS10eXBlcysKbXVsdGl2YWx1ZQ=='), c => c.charCodeAt(0));
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
  var f = 'fifteen.wasm';
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
  // Alguns missatges incorporen un comptador al final.
  var comptador = text.match(/^Moves: (\\d+)$/);
  if (comptador) return "Moviments: " + comptador[1];
  comptador = text.match(/^Moves since auto-solve: (\\d+)$/);
  if (comptador) return "Moviments des de la resolució automàtica: " + comptador[1];
  var exactes = {
    "Game ID": "Identificador de la partida",
    "Game random seed": "Llavor aleatòria de la partida",
    "Width": "Amplada",
    "Height": "Alçada",
    "Custom...": "Personalitzat...",
    "Delete": "Suprimeix",
    "Enter": "Retorn",
    "Spacebar": "Barra espaiadora",
    "Backspace": "Retrocés",
    "Escape": "Escapada",
    "Home": "Inici",
    "ArrowUp": "Fletxa amunt",
    "ArrowDown": "Fletxa avall",
    "ArrowLeft": "Fletxa esquerra",
    "ArrowRight": "Fletxa dreta",
    "PageUp": "Re pàg",
    "PageDown": "Av pàg",
    "Sense of arrow keys": "Sentit de les tecles de fletxa",
    "one-key-shortcuts": "Dreceres d'una sola tecla",
    "Keyboard shortcuts without Ctrl": "Dreceres de teclat sense Ctrl",
    "COMPLETED!": "COMPLETAT!",
    "This game does not support the Solve operation": "Aquest joc no permet resoldre la partida automàticament",
    "Width and height must both be at least two": "L'amplada i l'alçada han de ser, com a mínim, de dues caselles",
    "Moves since auto-solve: ": "Moviments des de la resolució automàtica: ",
    "Moves: ": "Moviments: "
  };
  if (Object.prototype.hasOwnProperty.call(exactes, text)) return exactes[text];
  return text;
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
  dialog_init(tradueixCA(UTF8ToString(titletext)));
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
