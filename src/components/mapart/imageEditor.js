import React, { Component } from "react";

import Tooltip from "../tooltip";
import GreenButtons from "./greenButtons";

import ColourMethods from "./json/colourMethods.json";
import DitherMethods from "./json/ditherMethods.json";
import MapModes from "./json/mapModes.json";
import WhereSupportBlocksModes from "./json/whereSupportBlocksModes.json";

import WorkerBuilder from "./workers/worker-builder";
import MapCanvasWorker from "./workers/mapCanvas";

import IMG_Null from "../../images/null.png";
import IMG_Textures from "../../images/textures.png";

import "./imageEditor.css";

/*
  Pixel editor for the dithered map. Holds its own copy of the image (this.imageData) which is only
  ever changed by the user: painting, filling, undo/redo, or explicitly copying the current map
  preview in. Settings changes upstream never touch it. Every committed edit is followed by a run of
  the map worker with dithering off, purely to recompute the per-map materials and support-block
  tallies that the download buttons need - every pixel is already a palette colour so that pass
  changes nothing visible, it just does the accounting.
*/

const TOOL_BRUSH = "brush";
const TOOL_BUCKET = "bucket";
const TOOL_EYEDROPPER = "eyedropper";
const TOOL_ERASER = "eraser";
const TOOL_PAN = "pan";
const TOOL_ZOOM = "zoom";

const TRANSPARENT = [0, 0, 0, 0]; // the Air "colour": no block at all in the NBT, as elsewhere in the app
const AIR_COLOUR_SET_ID = "61";
const isAir = (rgba) => rgba !== null && rgba.length > 3 && rgba[3] === 0;
const THUMBNAIL_MAX = 72; // longest side of a copied-selection thumbnail, in screen pixels

// Tool icons: simple 16x16 line drawings in currentColor, so they follow the button's text colour.
const svgIcon = (children) => (
  <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const ICONS = {
  brush: svgIcon(
    <React.Fragment>
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
      <path d="M9 4l3 3" />
    </React.Fragment>
  ),
  bucket: svgIcon(
    <React.Fragment>
      <path d="M3 8.5l5-5 5 5-5 5z" />
      <path d="M8 3.5V1.5" />
      <path d="M13.5 11.5c0 1.1-.7 2-1.5 2s-1.5-.9-1.5-2c0-1 1.5-2.5 1.5-2.5s1.5 1.5 1.5 2.5z" />
    </React.Fragment>
  ),
  eraser: svgIcon(
    <React.Fragment>
      <path d="M9.5 2.5l4 4L7 13H4.5l-2-2z" />
      <path d="M6 6l4 4" />
      <path d="M7 13h6.5" />
    </React.Fragment>
  ),
  eyedropper: svgIcon(
    <React.Fragment>
      <path d="M10 6L4 12v1.5H5.5L11.5 7.5" />
      <path d="M9 5l2.5 2.5" />
      <path d="M11 3.5l1.5-1.5 1.5 1.5L12.5 5" />
    </React.Fragment>
  ),
  pan: svgIcon(
    <React.Fragment>
      <path d="M5 9V4.5a1 1 0 0 1 2 0V8" />
      <path d="M7 8V3a1 1 0 0 1 2 0v5" />
      <path d="M9 8V4a1 1 0 0 1 2 0v4.5" />
      <path d="M11 8.5V6a1 1 0 0 1 2 0v3.5c0 3-2 4.5-4.5 4.5S4.5 12.5 4 11L2.8 8.8a1 1 0 0 1 1.7-1L5 9" />
    </React.Fragment>
  ),
  zoom: svgIcon(
    <React.Fragment>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
      <path d="M5 7h4M7 5v4" />
    </React.Fragment>
  ),
};

// The viewport is a square of VIEW_STEP multiples; the map (document) is drawn inside it at `zoom`
// screen pixels per map pixel, offset so that map coordinate (panX, panY) sits at the viewport's top-left.
const VIEW_STEP = 128;
const VIEW_MIN = 128;
const VIEW_DEFAULT = 384;
const ZOOM_LEVELS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

const HISTORY_LIMIT = 200;
const MATERIALS_DEBOUNCE_MS = 400;

class ImageEditor extends Component {
  state = {
    tool: TOOL_BRUSH,
    brushColour: null, // [r, g, b] or null before anything has been picked
    viewSize: VIEW_DEFAULT, // side of the square viewport, in screen pixels
    zoom: 3, // mirrored from this.view for the readout; the live value is this.view.zoom
    canvasWidth: 128,
    canvasHeight: 128,
    undoDepth: 0,
    redoDepth: 0,
    editorMaterialsData: { pixelsData: null, maps: null, currentSelectedBlocks: null },
    materialsWorker_inProgress: false,
    pixelsOutsidePalette: 0,
    panning: false,
    selectionMode: false, // brush / fill / eraser act on the selection mask instead of the picture
    selectedCount: 0, // number of pixels currently in the selection mask
    clipboard: [], // copied selections: { id, x, y, width, height, pixels, mask, count, thumbnail }
    revision: 0, // bumped on every change so the palette/warnings re-render
  };

  canvasRef = React.createRef();
  imageData = null; // ImageData; the single source of truth for the picture
  documentCanvas = null; // offscreen canvas mirroring imageData, drawn into the viewport scaled and offset
  selectionMask = null; // Uint8Array, one entry per pixel, 1 = selected
  maskCanvas = null; // offscreen canvas, opaque where selected, drawn hatched over the viewport
  overlayCanvas = null; // viewport-sized scratch used to clip the hatch pattern to the selection
  hatchPattern = null;
  checkerPattern = null;
  airAvailable = false; // whether the Air colour set is in the block selection (set by getPalette)
  nextClipboardId = 1;
  view = { zoom: 3, panX: 0, panY: 0 }; // kept off React state: it changes on every drag / wheel event
  drag = null; // { mode: "pan", lastX, lastY } or { mode: "paint", target: "image" | "mask", value } while a button is held
  undoStack = [];
  redoStack = [];
  currentStroke = null; // Map<pixelIndex, [r, g, b, a] before> while the mouse is down
  lastPaintedPixel = null;
  materialsWorker = null;
  materialsTimer = null;
  unmounted = false;

  componentDidMount() {
    this.imageData = new ImageData(this.state.canvasWidth, this.state.canvasHeight);
    this.documentCanvas = document.createElement("canvas");
    this.maskCanvas = document.createElement("canvas");
    this.overlayCanvas = document.createElement("canvas");
    this.selectionMask = new Uint8Array(this.state.canvasWidth * this.state.canvasHeight);
    this.syncDocumentCanvas();
    this.syncMaskCanvas();
    this.zoomToFit();
    window.addEventListener("mouseup", this.onWindowMouseUp);
    window.addEventListener("keydown", this.onKeyDown);
    // React registers wheel listeners as passive, which forbids preventDefault; Ctrl+wheel must not also
    // zoom the browser, so the listener goes on the element directly.
    this.canvasRef.current.addEventListener("wheel", this.onWheel, { passive: false });
    this.scheduleMaterials();
  }

  componentDidUpdate(prevProps, prevState) {
    this.componentDidUpdate_viewport(prevState);
    // The palette or the accounting rules changed: the tallies for the download buttons need redoing,
    // and the count of canvas pixels that are no longer paintable needs refreshing. The picture itself
    // is deliberately left alone.
    const relevant = [
      "selectedBlocks",
      "disabledTones",
      "optionValue_modeNBTOrMapdat",
      "optionValue_staircasing",
      "optionValue_whereSupportBlocks",
      "optionValue_transparency",
      "optionValue_transparencyTolerance",
      "optionValue_betterColour",
    ];
    if (relevant.some((key) => prevProps[key] !== this.props[key])) {
      this.scheduleMaterials();
    }
  }

  componentDidUpdate_viewport(prevState) {
    if (prevState.viewSize !== this.state.viewSize) {
      this.redraw(); // resizing a canvas element clears it
    }
  }

  componentWillUnmount() {
    this.unmounted = true;
    window.removeEventListener("mouseup", this.onWindowMouseUp);
    window.removeEventListener("mousemove", this.onWindowMouseMove);
    window.removeEventListener("keydown", this.onKeyDown);
    if (this.canvasRef.current !== null) {
      this.canvasRef.current.removeEventListener("wheel", this.onWheel);
    }
    clearTimeout(this.materialsTimer);
    if (this.materialsWorker !== null) {
      this.materialsWorker.terminate();
    }
  }

  // ---------------------------------------------------------------- palette

  // Every colour the current block selection, mode and staircasing can produce. Mirrors
  // setupColourSetsToUse() in the map worker so the swatches are exactly what the dither can emit.
  getPalette() {
    const { coloursJSON, selectedBlocks, disabledTones, optionValue_modeNBTOrMapdat, optionValue_staircasing } = this.props;
    const mapMode = Object.values(MapModes).find((mode) => mode.uniqueId === optionValue_modeNBTOrMapdat);
    const staircaseMode = Object.values(mapMode.staircaseModes).find((mode) => mode.uniqueId === optionValue_staircasing);
    const palette = [];
    for (const colourSetId of Object.keys(selectedBlocks)) {
      if (selectedBlocks[colourSetId] === "-1") {
        continue;
      }
      for (const toneKey of staircaseMode.toneKeys) {
        if (disabledTones[colourSetId].has(toneKey)) {
          continue;
        }
        const rgb = coloursJSON[colourSetId].tonesRGB[toneKey];
        if (rgb[0] < 0) {
          continue; // Air has no colour; it gets its own swatch below
        }
        const blockName = coloursJSON[colourSetId].blocks[selectedBlocks[colourSetId]].displayName;
        palette.push({ colourSetId, toneKey, rgb, blockName, label: staircaseMode.toneKeys.length > 1 ? `${blockName} (${toneKey})` : blockName });
      }
    }
    // Air is paintable whenever it is part of the block selection: pixels painted with it stay fully
    // transparent, which the map worker keeps as Air and the NBT worker turns into "no block here".
    this.airAvailable = selectedBlocks[AIR_COLOUR_SET_ID] !== undefined && selectedBlocks[AIR_COLOUR_SET_ID] !== "-1";
    // Order by colour rather than by colour set id: hue first, lightness within a hue, and near-greys
    // in their own group at the end from dark to light. Sorting on each colour set's normal tone keeps a
    // set's dark / normal / light triple together, so with staircasing on every row of nine is three sets.
    const hslOfSet = new Map();
    for (const { colourSetId } of palette) {
      if (!hslOfSet.has(colourSetId)) {
        hslOfSet.set(colourSetId, this.rgbToHsl(coloursJSON[colourSetId].tonesRGB.normal));
      }
    }
    const toneRank = { dark: 0, normal: 1, light: 2, unobtainable: 3 };
    const sortKey = (entry) => {
      const [h, sat, l] = hslOfSet.get(entry.colourSetId);
      const isGrey = sat < 0.12;
      return [isGrey ? 1 : 0, isGrey ? l : h, l, toneRank[entry.toneKey]];
    };
    palette.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      for (let k = 0; k < ka.length; k++) {
        if (ka[k] !== kb[k]) {
          return ka[k] - kb[k];
        }
      }
      return 0;
    });
    return palette;
  }

  rgbToHsl([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) {
      return [0, 0, l];
    }
    const sat = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) {
      h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    } else if (max === g) {
      h = ((b - r) / d + 2) * 60;
    } else {
      h = ((r - g) / d + 4) * 60;
    }
    return [h, sat, l];
  }

  paletteKey = (r, g, b) => (r << 16) | (g << 8) | b;

  countPixelsOutsidePalette() {
    const allowed = new Set(this.getPalette().map(({ rgb }) => this.paletteKey(rgb[0], rgb[1], rgb[2])));
    const data = this.imageData.data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) {
        if (!this.airAvailable) {
          count++; // transparent, but Air is not selected: the download will have to quantise it to a block
        }
      } else if (!allowed.has(this.paletteKey(data[i], data[i + 1], data[i + 2]))) {
        count++;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------- drawing

  // Copies imageData into the offscreen document canvas. Called after every pixel change.
  syncDocumentCanvas() {
    if (this.documentCanvas === null || this.imageData === null) {
      return;
    }
    if (this.documentCanvas.width !== this.imageData.width || this.documentCanvas.height !== this.imageData.height) {
      this.documentCanvas.width = this.imageData.width;
      this.documentCanvas.height = this.imageData.height;
    }
    this.documentCanvas.getContext("2d").putImageData(this.imageData, 0, 0);
  }

  // Mirrors selectionMask into maskCanvas: opaque white where selected, transparent elsewhere.
  syncMaskCanvas() {
    if (this.maskCanvas === null || this.selectionMask === null) {
      return;
    }
    const { width, height } = this.imageData;
    if (this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
    }
    const maskImage = new ImageData(width, height);
    const data = maskImage.data;
    for (let i = 0; i < this.selectionMask.length; i++) {
      if (this.selectionMask[i]) {
        const p = i * 4;
        data[p] = 255;
        data[p + 1] = 255;
        data[p + 2] = 255;
        data[p + 3] = 255;
      }
    }
    this.maskCanvas.getContext("2d").putImageData(maskImage, 0, 0);
  }

  // Small grey checkerboard, in screen space, drawn behind the document so transparent (Air) pixels are
  // recognisable as such rather than blending into the viewport background.
  getCheckerPattern(ctx) {
    if (this.checkerPattern === null) {
      const tile = document.createElement("canvas");
      tile.width = 16;
      tile.height = 16;
      const tctx = tile.getContext("2d");
      tctx.fillStyle = "#3a3a3a";
      tctx.fillRect(0, 0, 16, 16);
      tctx.fillStyle = "#2a2a2a";
      tctx.fillRect(0, 0, 8, 8);
      tctx.fillRect(8, 8, 8, 8);
      this.checkerPattern = ctx.createPattern(tile, "repeat");
    }
    return this.checkerPattern;
  }

  // Diagonal magenta / white stripes in screen space. Containing both a light and a saturated colour is
  // what keeps the selection visible whatever the picture underneath happens to be.
  getHatchPattern(ctx) {
    if (this.hatchPattern === null) {
      const tile = document.createElement("canvas");
      tile.width = 8;
      tile.height = 8;
      const tctx = tile.getContext("2d");
      tctx.fillStyle = "rgb(255, 0, 255)";
      tctx.fillRect(0, 0, 8, 8);
      tctx.strokeStyle = "rgb(255, 255, 255)";
      tctx.lineWidth = 2;
      tctx.beginPath();
      tctx.moveTo(-2, 10);
      tctx.lineTo(10, -2);
      tctx.moveTo(-2, 2);
      tctx.lineTo(2, -2);
      tctx.moveTo(6, 10);
      tctx.lineTo(10, 6);
      tctx.stroke();
      this.hatchPattern = ctx.createPattern(tile, "repeat");
    }
    return this.hatchPattern;
  }

  // Draws the document into the square viewport at the current pan and zoom, nearest-neighbour, with the
  // scaled offset snapped to whole screen pixels so the pixel grid never shimmers. The selection, if any,
  // goes on top as a hatched, semi-transparent layer.
  redraw() {
    const canvas = this.canvasRef.current;
    if (canvas === null || this.documentCanvas === null) {
      return;
    }
    const ctx = canvas.getContext("2d");
    const { zoom, panX, panY } = this.view;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const left = Math.round(-panX * zoom);
    const top = Math.round(-panY * zoom);
    const width = Math.round(this.imageData.width * zoom);
    const height = Math.round(this.imageData.height * zoom);
    ctx.fillStyle = this.getCheckerPattern(ctx);
    ctx.fillRect(left, top, width, height);
    ctx.drawImage(this.documentCanvas, left, top, width, height);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(left - 0.5, top - 0.5, width + 1, height + 1);

    if (this.state.selectedCount > 0 || (this.drag !== null && this.drag.target === "mask")) {
      // scale the mask into a viewport-sized layer, keep the hatch only where the mask is, then composite
      const overlay = this.overlayCanvas;
      if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
        overlay.width = canvas.width;
        overlay.height = canvas.height;
      }
      const octx = overlay.getContext("2d");
      octx.globalCompositeOperation = "source-over";
      octx.clearRect(0, 0, overlay.width, overlay.height);
      octx.imageSmoothingEnabled = false;
      octx.drawImage(this.maskCanvas, left, top, width, height);
      octx.globalCompositeOperation = "source-in";
      octx.fillStyle = this.getHatchPattern(octx);
      octx.fillRect(0, 0, overlay.width, overlay.height);
      octx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.55;
      ctx.drawImage(overlay, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  // Screen position of a mouse event -> fractional document coordinates
  documentPointFromEvent(e) {
    const rect = this.canvasRef.current.getBoundingClientRect();
    const { zoom, panX, panY } = this.view;
    return {
      x: panX + (e.clientX - rect.left) / zoom,
      y: panY + (e.clientY - rect.top) / zoom,
      screenX: e.clientX - rect.left,
      screenY: e.clientY - rect.top,
    };
  }

  pixelIndexFromEvent(e) {
    const { x, y } = this.documentPointFromEvent(e);
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.imageData.width || py >= this.imageData.height) {
      return null;
    }
    return py * this.imageData.width + px;
  }

  // ---------------------------------------------------------------- pan and zoom

  // Keeps at least a sliver of the document inside the viewport so it can never be lost off-screen.
  clampPan() {
    const { zoom } = this.view;
    const viewDoc = this.state.viewSize / zoom; // viewport size in document pixels
    const minVisible = Math.min(32 / zoom, this.imageData.width, this.imageData.height);
    this.view.panX = Math.min(Math.max(this.view.panX, -viewDoc + minVisible), this.imageData.width - minVisible);
    this.view.panY = Math.min(Math.max(this.view.panY, -viewDoc + minVisible), this.imageData.height - minVisible);
  }

  setZoom(newZoom, anchorScreenX, anchorScreenY) {
    // Zoom about a screen point: the document coordinate under it stays put.
    const { zoom, panX, panY } = this.view;
    const docX = panX + anchorScreenX / zoom;
    const docY = panY + anchorScreenY / zoom;
    this.view.zoom = newZoom;
    this.view.panX = docX - anchorScreenX / newZoom;
    this.view.panY = docY - anchorScreenY / newZoom;
    this.clampPan();
    this.redraw();
    this.setState({ zoom: newZoom });
  }

  stepZoom(direction, anchorScreenX, anchorScreenY) {
    const current = this.view.zoom;
    const next = direction > 0 ? ZOOM_LEVELS.find((level) => level > current + 1e-9) : [...ZOOM_LEVELS].reverse().find((level) => level < current - 1e-9);
    if (next !== undefined) {
      this.setZoom(next, anchorScreenX, anchorScreenY);
    }
  }

  // Fit the whole document in the viewport and centre it. Used when a document arrives or changes size.
  zoomToFit() {
    const { viewSize } = this.state;
    const fit = Math.min(viewSize / this.imageData.width, viewSize / this.imageData.height);
    this.view.zoom = fit;
    this.view.panX = (this.imageData.width - viewSize / fit) / 2;
    this.view.panY = (this.imageData.height - viewSize / fit) / 2;
    this.redraw();
    this.setState({ zoom: fit });
  }

  panBy(screenDx, screenDy) {
    this.view.panX -= screenDx / this.view.zoom;
    this.view.panY -= screenDy / this.view.zoom;
    this.clampPan();
    this.redraw();
  }

  // No fixed ceiling: the viewport can grow until it would no longer fit the browser window.
  changeViewSize = (delta) => {
    const viewMax = Math.max(VIEW_MIN, Math.floor((Math.min(window.innerWidth, window.innerHeight) - 32) / VIEW_STEP) * VIEW_STEP);
    this.setState((state) => ({ viewSize: Math.min(Math.max(state.viewSize + delta * VIEW_STEP, VIEW_MIN), viewMax) }));
  };

  // Writes one pixel, remembering its previous value in the current stroke the first time it is touched.
  // rgba may be a 3-element colour (painted opaque) or a 4-element value (the eraser's transparent).
  setPixel(pixelIndex, rgba) {
    const data = this.imageData.data;
    const i = pixelIndex * 4;
    const alpha = rgba.length > 3 ? rgba[3] : 255;
    if (data[i] === rgba[0] && data[i + 1] === rgba[1] && data[i + 2] === rgba[2] && data[i + 3] === alpha) {
      return;
    }
    if (this.currentStroke !== null && !this.currentStroke.has(pixelIndex)) {
      this.currentStroke.set(pixelIndex, [data[i], data[i + 1], data[i + 2], data[i + 3]]);
    }
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = alpha;
  }

  setMaskPixel(pixelIndex, value) {
    if (this.selectionMask[pixelIndex] !== value) {
      this.selectionMask[pixelIndex] = value;
      this.selectedCountLive += value ? 1 : -1;
    }
  }

  // Applies the current drag's paint value (picture colour or mask state) to one pixel.
  applyPaint(pixelIndex) {
    if (this.drag.target === "mask") {
      this.setMaskPixel(pixelIndex, this.drag.value);
    } else {
      this.setPixel(pixelIndex, this.drag.value);
    }
  }

  // Bresenham between two pixel indices so a fast drag leaves an unbroken line.
  paintLine(fromIndex, toIndex) {
    const width = this.imageData.width;
    let x0 = fromIndex % width;
    let y0 = (fromIndex - x0) / width;
    const x1 = toIndex % width;
    const y1 = (toIndex - x1) / width;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.applyPaint(y0 * width + x0);
      if (x0 === x1 && y0 === y1) {
        break;
      }
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  // Four-connected flood fill over pixels that exactly match the clicked pixel's RGBA.
  floodFill(startIndex, rgba) {
    const { width, height, data } = this.imageData;
    const s = startIndex * 4;
    const target = [data[s], data[s + 1], data[s + 2], data[s + 3]];
    const alpha = rgba.length > 3 ? rgba[3] : 255;
    if (target[0] === rgba[0] && target[1] === rgba[1] && target[2] === rgba[2] && target[3] === alpha) {
      return;
    }
    const visited = new Uint8Array(width * height);
    const stack = [startIndex];
    visited[startIndex] = 1;
    while (stack.length > 0) {
      const index = stack.pop();
      this.setPixel(index, rgba);
      const x = index % width;
      const y = (index - x) / width;
      const neighbours = [];
      if (x > 0) neighbours.push(index - 1);
      if (x < width - 1) neighbours.push(index + 1);
      if (y > 0) neighbours.push(index - width);
      if (y < height - 1) neighbours.push(index + width);
      for (const n of neighbours) {
        if (visited[n]) {
          continue;
        }
        const p = n * 4;
        if (data[p] === target[0] && data[p + 1] === target[1] && data[p + 2] === target[2] && data[p + 3] === target[3]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
  }

  // Selection-mode fill: selects every unselected pixel reachable from the click without crossing selected
  // ones. Paint a closed outline with the brush, click inside, and the enclosed area joins the selection.
  floodFillMask(startIndex) {
    const { width, height } = this.imageData;
    if (this.selectionMask[startIndex]) {
      return;
    }
    const stack = [startIndex];
    this.setMaskPixel(startIndex, 1);
    while (stack.length > 0) {
      const index = stack.pop();
      const x = index % width;
      const y = (index - x) / width;
      const neighbours = [];
      if (x > 0) neighbours.push(index - 1);
      if (x < width - 1) neighbours.push(index + 1);
      if (y > 0) neighbours.push(index - width);
      if (y < height - 1) neighbours.push(index + width);
      for (const n of neighbours) {
        if (!this.selectionMask[n]) {
          this.setMaskPixel(n, 1);
          stack.push(n);
        }
      }
    }
  }

  // ---------------------------------------------------------------- selection and copied selections

  selectedCountLive = 0; // running count while a mask stroke is in progress; committed to state afterwards

  afterMaskChange() {
    this.syncMaskCanvas();
    this.setState({ selectedCount: this.selectedCountLive });
    this.redraw();
  }

  clearSelection() {
    this.selectionMask.fill(0);
    this.selectedCountLive = 0;
    this.afterMaskChange();
  }

  // Lifts the selected pixels (with their positions) into a copied-selection entry and clears the selection.
  onCopySelection = () => {
    const { width, height, data } = this.imageData;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < this.selectionMask.length; i++) {
      if (this.selectionMask[i]) {
        const x = i % width;
        const y = (i - x) / width;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) {
      return;
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const pixels = new Uint8ClampedArray(w * h * 4);
    const mask = new Uint8Array(w * h);
    let count = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (minY + y) * width + (minX + x);
        if (!this.selectionMask[src]) {
          continue;
        }
        const dst = y * w + x;
        mask[dst] = 1;
        pixels.set(data.subarray(src * 4, src * 4 + 4), dst * 4);
        count++;
      }
    }
    // thumbnail: only the copied pixels, everything else transparent
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = w;
    thumbCanvas.height = h;
    thumbCanvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
    const entry = { id: this.nextClipboardId++, x: minX, y: minY, width: w, height: h, pixels, mask, count, thumbnail: thumbCanvas.toDataURL("image/png") };
    this.setState((state) => ({ clipboard: [...state.clipboard, entry] }));
    this.clearSelection();
  };

  // Writes a copied selection's pixels back exactly where they came from, as one undoable stroke.
  onPasteClipboardEntry = (entry) => {
    if (entry.x + entry.width > this.imageData.width || entry.y + entry.height > this.imageData.height) {
      return; // cannot happen while the canvas size is unchanged, but never write out of bounds
    }
    this.currentStroke = new Map();
    for (let y = 0; y < entry.height; y++) {
      for (let x = 0; x < entry.width; x++) {
        const local = y * entry.width + x;
        if (entry.mask[local]) {
          this.setPixel((entry.y + y) * this.imageData.width + (entry.x + x), entry.pixels.subarray(local * 4, local * 4 + 4));
        }
      }
    }
    this.finishStroke();
  };

  onDeleteClipboardEntry = (id) => {
    this.setState((state) => ({ clipboard: state.clipboard.filter((entry) => entry.id !== id) }));
  };

  // ---------------------------------------------------------------- history

  // A history entry is either a pixel diff ({ type: "pixels", indices, before, after }) or a whole
  // snapshot ({ type: "snapshot", before: ImageData, after: ImageData }) for edits that resize.
  pushHistory(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.afterChange();
  }

  finishStroke() {
    if (this.currentStroke === null) {
      return;
    }
    const stroke = this.currentStroke;
    this.currentStroke = null;
    this.lastPaintedPixel = null;
    if (stroke.size === 0) {
      return;
    }
    const indices = new Uint32Array(stroke.size);
    const before = new Uint8ClampedArray(stroke.size * 4);
    const after = new Uint8ClampedArray(stroke.size * 4);
    let k = 0;
    for (const [pixelIndex, previous] of stroke) {
      indices[k] = pixelIndex;
      before.set(previous, k * 4);
      after.set(this.imageData.data.subarray(pixelIndex * 4, pixelIndex * 4 + 4), k * 4);
      k++;
    }
    this.pushHistory({ type: "pixels", indices, before, after });
  }

  applyPixels(indices, values) {
    const data = this.imageData.data;
    for (let k = 0; k < indices.length; k++) {
      data.set(values.subarray(k * 4, k * 4 + 4), indices[k] * 4);
    }
  }

  applySnapshot(snapshot) {
    const sizeChanged = snapshot.width !== this.imageData.width || snapshot.height !== this.imageData.height;
    this.imageData = new ImageData(new Uint8ClampedArray(snapshot.data), snapshot.width, snapshot.height);
    this.syncDocumentCanvas();
    if (sizeChanged) {
      // positions in the selection and in copied selections only mean something at the size they were made
      this.selectionMask = new Uint8Array(snapshot.width * snapshot.height);
      this.selectedCountLive = 0;
      this.syncMaskCanvas();
      this.setState({ selectedCount: 0, clipboard: [] });
    }
    this.setState({ canvasWidth: snapshot.width, canvasHeight: snapshot.height }, () => this.zoomToFit());
  }

  undo = () => {
    if (this.currentStroke !== null || this.undoStack.length === 0) {
      return;
    }
    const entry = this.undoStack.pop();
    this.redoStack.push(entry);
    if (entry.type === "pixels") {
      this.applyPixels(entry.indices, entry.before);
    } else {
      this.applySnapshot(entry.before);
    }
    this.afterChange();
  };

  redo = () => {
    if (this.currentStroke !== null || this.redoStack.length === 0) {
      return;
    }
    const entry = this.redoStack.pop();
    this.undoStack.push(entry);
    if (entry.type === "pixels") {
      this.applyPixels(entry.indices, entry.after);
    } else {
      this.applySnapshot(entry.after);
    }
    this.afterChange();
  };

  afterChange() {
    this.syncDocumentCanvas();
    this.redraw();
    this.setState((state) => ({
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      revision: state.revision + 1,
    }));
    this.scheduleMaterials();
  }

  // ---------------------------------------------------------------- copy from preview

  onCopyFromPreview = () => {
    const { currentMaterialsData, optionValue_mapSize_x, optionValue_mapSize_y } = this.props;
    const width = 128 * optionValue_mapSize_x;
    const height = 128 * optionValue_mapSize_y;
    if (currentMaterialsData.pixelsData === null || currentMaterialsData.pixelsData.length !== width * height * 4) {
      return;
    }
    const before = new ImageData(new Uint8ClampedArray(this.imageData.data), this.imageData.width, this.imageData.height);
    const after = new ImageData(new Uint8ClampedArray(currentMaterialsData.pixelsData), width, height);
    this.applySnapshot(after);
    this.pushHistory({ type: "snapshot", before, after });
  };

  // ---------------------------------------------------------------- mouse and keyboard

  pickColourAt(pixelIndex) {
    const data = this.imageData.data;
    const i = pixelIndex * 4;
    if (data[i + 3] !== 0) {
      this.setState({ brushColour: [data[i], data[i + 1], data[i + 2]] });
    } else if (this.airAvailable) {
      this.setState({ brushColour: TRANSPARENT });
    }
  }

  beginPan(e) {
    this.drag = { mode: "pan", lastX: e.clientX, lastY: e.clientY };
    window.addEventListener("mousemove", this.onWindowMouseMove);
    this.setState({ panning: true });
  }

  // Starts a brush / eraser drag. target "image" writes rgba into the picture (recorded for undo);
  // target "mask" writes 1 / 0 into the selection mask.
  beginPaint(pixelIndex, target, value) {
    this.drag = { mode: "paint", target, value };
    if (target === "image") {
      this.currentStroke = new Map();
    }
    this.applyPaint(pixelIndex);
    this.lastPaintedPixel = pixelIndex;
    this.afterPaintStep();
    window.addEventListener("mousemove", this.onWindowMouseMove);
  }

  afterPaintStep() {
    if (this.drag.target === "mask") {
      this.syncMaskCanvas();
    } else {
      this.syncDocumentCanvas();
    }
    this.redraw();
  }

  onCanvasMouseDown = (e) => {
    e.preventDefault();
    const pixelIndex = this.pixelIndexFromEvent(e);
    // Modifier gestures work in every tool: right-click picks a colour, middle button or Ctrl+left pans.
    // The one exception is the zoom tool, where right-click is the natural "zoom out".
    if (e.button === 2) {
      if (this.state.tool === TOOL_ZOOM) {
        const { screenX, screenY } = this.documentPointFromEvent(e);
        this.stepZoom(-1, screenX, screenY);
      } else if (pixelIndex !== null) {
        this.pickColourAt(pixelIndex);
      }
      return;
    }
    if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
      this.beginPan(e);
      return;
    }
    if (e.button !== 0) {
      return;
    }
    const { tool, brushColour, selectionMode } = this.state;
    const { screenX, screenY } = this.documentPointFromEvent(e);
    switch (tool) {
      case TOOL_PAN:
        this.beginPan(e);
        return;
      case TOOL_ZOOM:
        this.stepZoom(e.altKey || e.shiftKey ? -1 : 1, screenX, screenY);
        return;
      case TOOL_EYEDROPPER:
        if (pixelIndex !== null) {
          this.pickColourAt(pixelIndex);
        }
        return;
      case TOOL_BUCKET:
        if (pixelIndex === null) {
          return;
        }
        if (selectionMode) {
          this.drag = { mode: "paint", target: "mask", value: 1 }; // so redraw shows the hatch immediately
          this.floodFillMask(pixelIndex);
          this.drag = null;
          this.afterMaskChange();
        } else if (brushColour !== null) {
          this.currentStroke = new Map();
          this.floodFill(pixelIndex, brushColour);
          this.finishStroke();
        }
        return;
      case TOOL_ERASER:
        if (pixelIndex !== null) {
          this.beginPaint(pixelIndex, selectionMode ? "mask" : "image", selectionMode ? 0 : TRANSPARENT);
        }
        return;
      case TOOL_BRUSH:
      default:
        if (pixelIndex === null) {
          return;
        }
        if (selectionMode) {
          this.beginPaint(pixelIndex, "mask", 1);
        } else if (brushColour !== null) {
          this.beginPaint(pixelIndex, "image", brushColour);
        }
        return;
    }
  };

  // Attached to the window for the duration of a drag so leaving the canvas mid-gesture is harmless.
  onWindowMouseMove = (e) => {
    if (this.drag === null) {
      return;
    }
    if (this.drag.mode === "pan") {
      this.panBy(e.clientX - this.drag.lastX, e.clientY - this.drag.lastY);
      this.drag.lastX = e.clientX;
      this.drag.lastY = e.clientY;
      return;
    }
    const pixelIndex = this.pixelIndexFromEvent(e);
    if (pixelIndex === null) {
      return;
    }
    if (this.lastPaintedPixel === null) {
      this.applyPaint(pixelIndex);
    } else if (pixelIndex !== this.lastPaintedPixel) {
      this.paintLine(this.lastPaintedPixel, pixelIndex);
    }
    this.lastPaintedPixel = pixelIndex;
    this.afterPaintStep();
  };

  onWindowMouseUp = () => {
    if (this.drag === null) {
      return;
    }
    const { mode, target } = this.drag;
    this.drag = null;
    this.lastPaintedPixel = null;
    window.removeEventListener("mousemove", this.onWindowMouseMove);
    if (mode === "pan") {
      this.setState({ panning: false });
    } else if (target === "mask") {
      this.afterMaskChange();
    } else {
      this.finishStroke();
    }
  };

  onToggleSelectionMode = () => {
    this.setState((state) => ({ selectionMode: !state.selectionMode }));
  };

  onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) {
      return; // plain scrolling still scrolls the page
    }
    e.preventDefault();
    const { screenX, screenY } = this.documentPointFromEvent(e);
    this.stepZoom(e.deltaY < 0 ? 1 : -1, screenX, screenY);
  };

  onKeyDown = (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) {
      return;
    }
    const details = this.canvasRef.current !== null && this.canvasRef.current.closest("details");
    if (!details || !details.open) {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
    }
  };

  // ---------------------------------------------------------------- materials for the download buttons

  scheduleMaterials() {
    clearTimeout(this.materialsTimer);
    this.materialsTimer = setTimeout(() => this.computeMaterials(), MATERIALS_DEBOUNCE_MS);
  }

  computeMaterials() {
    if (this.unmounted || this.imageData === null) {
      return;
    }
    const {
      coloursJSON,
      selectedBlocks,
      disabledTones,
      optionValue_modeNBTOrMapdat,
      optionValue_staircasing,
      optionValue_whereSupportBlocks,
      optionValue_transparency,
      optionValue_transparencyTolerance,
      optionValue_betterColour,
    } = this.props;
    if (this.materialsWorker !== null) {
      this.materialsWorker.terminate();
    }
    this.setState({ materialsWorker_inProgress: true, pixelsOutsidePalette: this.countPixelsOutsidePalette() });
    const canvasImageData = new ImageData(new Uint8ClampedArray(this.imageData.data), this.imageData.width, this.imageData.height);
    this.materialsWorker = new WorkerBuilder(MapCanvasWorker);
    this.materialsWorker.onmessage = (e) => {
      if (e.data.head !== "PIXELS_MATERIALS_CURRENTSELECTEDBLOCKS" || this.unmounted) {
        return;
      }
      this.materialsWorker.terminate();
      this.materialsWorker = null;
      this.setState({
        materialsWorker_inProgress: false,
        editorMaterialsData: {
          pixelsData: e.data.body.pixels.data,
          maps: e.data.body.maps,
          currentSelectedBlocks: e.data.body.currentSelectedBlocks,
        },
      });
    };
    this.materialsWorker.postMessage({
      head: "PIXELS",
      body: {
        coloursJSON: coloursJSON,
        MapModes: MapModes,
        WhereSupportBlocksModes: WhereSupportBlocksModes,
        ColourMethods: ColourMethods,
        DitherMethods: DitherMethods,
        canvasImageData: canvasImageData,
        selectedBlocks: selectedBlocks,
        disabledTones: disabledTones,
        optionValue_modeNBTOrMapdat: optionValue_modeNBTOrMapdat,
        optionValue_mapSize_x: this.imageData.width / 128,
        optionValue_mapSize_y: this.imageData.height / 128,
        optionValue_staircasing: optionValue_staircasing,
        optionValue_whereSupportBlocks: optionValue_whereSupportBlocks,
        optionValue_transparency: optionValue_transparency,
        optionValue_transparencyTolerance: optionValue_transparencyTolerance,
        optionValue_betterColour: optionValue_betterColour,
        optionValue_dithering: DitherMethods.None.uniqueId,
        optionValue_dithering_propagation_red: 100,
        optionValue_dithering_propagation_green: 100,
        optionValue_dithering_propagation_blue: 100,
        optionValue_dithering_boustrophedon: false,
        optionValue_curveOrder: null,
      },
    });
  }

  // ---------------------------------------------------------------- render

  render() {
    const { getLocaleString, currentMaterialsData, mapPreviewWorker_inProgress, optionValue_mapSize_x, optionValue_mapSize_y, uploadedImage_baseFilename } = this.props;
    const {
      tool,
      brushColour,
      viewSize,
      zoom,
      canvasWidth,
      canvasHeight,
      undoDepth,
      redoDepth,
      editorMaterialsData,
      materialsWorker_inProgress,
      pixelsOutsidePalette,
      panning,
      selectionMode,
      selectedCount,
      clipboard,
    } = this.state;
    const palette = this.getPalette();
    const brushIsAir = isAir(brushColour);
    const brushKey = brushColour === null || brushIsAir ? null : this.paletteKey(brushColour[0], brushColour[1], brushColour[2]);
    const canCopy = !mapPreviewWorker_inProgress && currentMaterialsData.pixelsData !== null && currentMaterialsData.pixelsData.length === 128 * optionValue_mapSize_x * 128 * optionValue_mapSize_y * 4;
    const brushSwatchEntry = brushKey === null ? undefined : palette.find(({ rgb }) => this.paletteKey(rgb[0], rgb[1], rgb[2]) === brushKey);
    const cursors = { [TOOL_BRUSH]: "crosshair", [TOOL_BUCKET]: "crosshair", [TOOL_EYEDROPPER]: "copy", [TOOL_ERASER]: "crosshair", [TOOL_PAN]: "grab", [TOOL_ZOOM]: "zoom-in" };
    const cursor = panning ? "grabbing" : cursors[tool];

    const toolButton = (toolId, labelKey, icon) => (
      <button
        key={toolId}
        className={`editorToolButton editorIconButton${tool === toolId ? " editorToolButton_active" : ""}`}
        title={getLocaleString(`IMAGE-EDITOR/${labelKey}`)}
        onClick={() => this.setState({ tool: toolId })}
      >
        {icon}
      </button>
    );

    return (
      <details className="section boxed imageEditorDiv">
        <summary className="imageEditorSummary">
          <h2>{getLocaleString("IMAGE-EDITOR/TITLE")}</h2>
        </summary>
        <div className="imageEditorSubtitle">{getLocaleString("IMAGE-EDITOR/SUBTITLE")}</div>
        <div className="imageEditorSubtitle">{getLocaleString("IMAGE-EDITOR/SHORTCUTS")}</div>

        <div className="editorToolbar">
          <Tooltip tooltipText={getLocaleString("IMAGE-EDITOR/COPY-FROM-PREVIEW-TT")}>
            <button className="editorToolButton" onClick={this.onCopyFromPreview} disabled={!canCopy}>
              {getLocaleString("IMAGE-EDITOR/COPY-FROM-PREVIEW")}
            </button>
          </Tooltip>
          <span className="editorToolbarSpacer" />
          <button
            className={`editorToolButton editorToggleButton${selectionMode ? " editorToggleButton_on" : ""}`}
            onClick={this.onToggleSelectionMode}
            aria-pressed={selectionMode}
          >
            {getLocaleString("IMAGE-EDITOR/SELECTION-MODE")}
          </button>
          {selectionMode && (
            <button className="editorToolButton" onClick={this.onCopySelection} disabled={selectedCount === 0}>
              {getLocaleString("IMAGE-EDITOR/COPY-SELECTION")}
            </button>
          )}
        </div>

        <div className="editorBody">
          <div className="editorToolColumn">
            {toolButton(TOOL_BRUSH, "BRUSH", ICONS.brush)}
            {toolButton(TOOL_BUCKET, "BUCKET", ICONS.bucket)}
            {toolButton(TOOL_ERASER, "ERASER", ICONS.eraser)}
            {toolButton(TOOL_EYEDROPPER, "EYEDROPPER", ICONS.eyedropper)}
            {toolButton(TOOL_PAN, "PAN", ICONS.pan)}
            {toolButton(TOOL_ZOOM, "ZOOM", ICONS.zoom)}
          </div>

          <div className="editorViewportColumn">
            <canvas
              className="editorCanvas"
              width={viewSize}
              height={viewSize}
              ref={this.canvasRef}
              style={{ width: `${viewSize.toString()}px`, height: `${viewSize.toString()}px`, cursor: cursor }}
              onMouseDown={this.onCanvasMouseDown}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div className="editorUnderCanvas">
              <small>{`${canvasWidth.toString()}x${canvasHeight.toString()} \u00b7 ${Math.round(zoom * 100).toString()}%`}</small>
              <div className="editorHistoryButtons">
                <button className="editorToolButton" onClick={this.undo} disabled={undoDepth === 0} title={getLocaleString("IMAGE-EDITOR/UNDO")}>
                  {"\u21b6"}
                </button>
                <button className="editorToolButton" onClick={this.redo} disabled={redoDepth === 0} title={getLocaleString("IMAGE-EDITOR/REDO")}>
                  {"\u21b7"}
                </button>
              </div>
              <div>
                <img
                  alt="+"
                  className="sizeButton"
                  src={IMG_Null}
                  style={{ backgroundImage: `url(${IMG_Textures})`, backgroundPositionX: "-96px", backgroundPositionY: "-2048px" }}
                  onClick={() => this.changeViewSize(1)}
                />
                <img
                  alt="-"
                  className="sizeButton"
                  src={IMG_Null}
                  style={{ backgroundImage: `url(${IMG_Textures})`, backgroundPositionX: "-128px", backgroundPositionY: "-2048px" }}
                  onClick={() => this.changeViewSize(-1)}
                />
              </div>
            </div>
          </div>

          <div className="editorPaletteColumn">
            <div>
              <b>{getLocaleString("IMAGE-EDITOR/PALETTE")}</b> <small className="editorPaletteNote">{getLocaleString("IMAGE-EDITOR/PALETTE-NOTE")}</small>
            </div>
            <div className="editorPalette">
              {this.airAvailable && (
                <div
                  className={`editorSwatch editorSwatch_air${brushIsAir ? " editorSwatch_selected" : ""}`}
                  title={getLocaleString("IMAGE-EDITOR/AIR")}
                  onClick={() => this.setState({ brushColour: TRANSPARENT })}
                />
              )}
              {palette.map(({ colourSetId, toneKey, rgb, label }) => {
                const key = this.paletteKey(rgb[0], rgb[1], rgb[2]);
                return (
                  <div
                    key={`${colourSetId}_${toneKey}`}
                    className={`editorSwatch${key === brushKey ? " editorSwatch_selected" : ""}`}
                    title={label}
                    style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
                    onClick={() => this.setState({ brushColour: rgb })}
                  />
                );
              })}
            </div>
            <div className="editorBrushColour">
              <span
                className={`editorSwatch editorActiveSwatch${brushColour === null ? " editorActiveSwatch_empty" : ""}${brushIsAir ? " editorSwatch_air" : ""}`}
                title={brushIsAir ? getLocaleString("IMAGE-EDITOR/AIR") : brushSwatchEntry === undefined ? undefined : brushSwatchEntry.label}
                style={brushColour === null || brushIsAir ? undefined : { backgroundColor: `rgb(${brushColour[0]}, ${brushColour[1]}, ${brushColour[2]})` }}
              />
              <small>
                {brushColour === null
                  ? getLocaleString("IMAGE-EDITOR/NO-COLOUR")
                  : brushIsAir
                  ? getLocaleString("IMAGE-EDITOR/AIR")
                  : `${brushSwatchEntry === undefined ? "" : `${brushSwatchEntry.label} \u00b7 `}rgb(${brushColour[0]}, ${brushColour[1]}, ${brushColour[2]})`}
              </small>
            </div>
          </div>
        </div>

        {clipboard.length > 0 && (
          <div className="editorClipboard">
            <b>{getLocaleString("IMAGE-EDITOR/COPIED-SELECTIONS")}</b>
            {clipboard.map((entry) => (
              <div key={entry.id} className="editorClipboardEntry">
                <img
                  className="editorClipboardThumb"
                  src={entry.thumbnail}
                  alt=""
                  title={`${entry.width}x${entry.height} @ ${entry.x},${entry.y} \u00b7 ${entry.count} px`}
                  style={entry.width >= entry.height ? { width: `${THUMBNAIL_MAX}px` } : { height: `${THUMBNAIL_MAX}px` }}
                />
                <span className="editorClipboardDash">{"\u2014"}</span>
                <button className="editorToolButton" onClick={() => this.onPasteClipboardEntry(entry)}>
                  {getLocaleString("IMAGE-EDITOR/PASTE-TO-CANVAS")}
                </button>
                <button className="editorToolButton editorClipboardDelete" onClick={() => this.onDeleteClipboardEntry(entry.id)} title={getLocaleString("IMAGE-EDITOR/DELETE-COPIED")}>
                  {"\u00d7"}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="editorDownloads">
          <b>{getLocaleString("IMAGE-EDITOR/DOWNLOAD-EDITED")}</b>
          {pixelsOutsidePalette > 0 && (
            <small className="editorWarning">{`${pixelsOutsidePalette.toString()} ${getLocaleString("IMAGE-EDITOR/OUTSIDE-PALETTE")}`}</small>
          )}
          <GreenButtons
            {...this.props}
            optionValue_mapSize_x={canvasWidth / 128}
            optionValue_mapSize_y={canvasHeight / 128}
            uploadedImage_baseFilename={`${uploadedImage_baseFilename === null ? "mapart" : uploadedImage_baseFilename}_edited`}
            currentMaterialsData={editorMaterialsData}
            mapPreviewWorker_inProgress={materialsWorker_inProgress || editorMaterialsData.pixelsData === null}
          />
        </div>
      </details>
    );
  }
}

export default ImageEditor;
