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
  Pixel editor for the dithered map. The picture is a stack of layers (this.layers, bottom first),
  each a full-canvas ImageData of opaque or fully transparent pixels; this.imageData is their composite
  (the top-most opaque pixel wins), which is what the viewport shows, what the eyedropper and copy tools
  read, and what the download buttons export. Edits go to the one active layer. Nothing here is changed
  by settings upstream: layers only change by painting, filling, erasing, undo/redo, layer management, or
  explicitly opening the current map preview as a new layer. Every committed edit is followed by a run of
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
const LAYER_THUMB = 56; // longest side of a layer thumbnail, in screen pixels

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
  eyeOpen: svgIcon(
    <React.Fragment>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </React.Fragment>
  ),
  eyeClosed: svgIcon(
    <React.Fragment>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <path d="M2.5 13.5l11-11" />
    </React.Fragment>
  ),
  trash: svgIcon(
    <React.Fragment>
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3h4v1.5" />
      <path d="M4.5 4.5l.7 8.5h5.6l.7-8.5" />
      <path d="M6.8 7v4M9.2 7v4" />
    </React.Fragment>
  ),
  chevronUp: svgIcon(<path d="M4 10l4-4 4 4" />),
  chevronDown: svgIcon(<path d="M4 6l4 4 4-4" />),
  plus: svgIcon(<path d="M8 3.5v9M3.5 8h9" />),
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
    layerList: [], // [{ id, visible, thumbnail }] bottom first, mirrored from this.layers for rendering
    activeLayerId: null,
    copyStatus: null, // "copied" | "downloaded" briefly after the Copy image button, else null
    openedBaseFilename: null, // base filename of the image that was last opened into the editor
    revision: 0, // bumped on every change so the palette/warnings re-render
  };

  canvasRef = React.createRef();
  detailsRef = React.createRef();
  layers = []; // [{ id, visible, imageData, canvas }] bottom first; the source of truth for the picture
  activeLayerId = null;
  nextLayerId = 1;
  imageData = null; // ImageData: the composite of the visible layers, rebuilt by recomposite()
  documentCanvas = null; // offscreen canvas holding the composite, drawn into the viewport scaled and offset
  selectionMask = null; // Uint8Array, one entry per pixel, 1 = selected
  maskCanvas = null; // offscreen canvas, opaque where selected, drawn hatched over the viewport
  overlayCanvas = null; // viewport-sized scratch used to clip the hatch pattern to the selection
  hatchPattern = null;
  checkerPattern = null;
  airAvailable = false; // whether the Air colour set is in the block selection (set by getPalette)
  view = { zoom: 3, panX: 0, panY: 0 }; // kept off React state: it changes on every drag / wheel event
  drag = null; // { mode: "pan", lastX, lastY } or { mode: "paint", target: "image" | "mask", value } while a button is held
  undoStack = [];
  redoStack = [];
  currentStroke = null; // Map<pixelIndex, [r, g, b, a] before> while the mouse is down
  lastPaintedPixel = null;
  materialsWorker = null;
  materialsTimer = null;
  copyStatusTimer = null;
  unmounted = false;

  componentDidMount() {
    this.documentCanvas = document.createElement("canvas");
    this.maskCanvas = document.createElement("canvas");
    this.overlayCanvas = document.createElement("canvas");
    this.selectionMask = new Uint8Array(this.state.canvasWidth * this.state.canvasHeight);
    // there is always at least one layer; start with an empty one at the default size
    const first = this.makeLayer(new ImageData(this.state.canvasWidth, this.state.canvasHeight));
    this.layers = [first];
    this.activeLayerId = first.id;
    this.recomposite();
    this.publishLayers();
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
    clearTimeout(this.copyStatusTimer);
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

  // ---------------------------------------------------------------- layers

  makeLayer(imageData, visible = true) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const layer = { id: this.nextLayerId++, visible, imageData, canvas, thumbnail: null };
    this.syncLayerCanvas(layer);
    return layer;
  }

  activeLayer() {
    return this.layers.find((layer) => layer.id === this.activeLayerId) || this.layers[this.layers.length - 1];
  }

  // Copies a layer's pixels into its own canvas (so compositing is one drawImage per layer) and refreshes
  // its thumbnail.
  syncLayerCanvas(layer) {
    layer.canvas.getContext("2d").putImageData(layer.imageData, 0, 0);
    const scale = Math.min(LAYER_THUMB / layer.imageData.width, LAYER_THUMB / layer.imageData.height, 1);
    const thumb = document.createElement("canvas");
    thumb.width = Math.max(1, Math.round(layer.imageData.width * scale));
    thumb.height = Math.max(1, Math.round(layer.imageData.height * scale));
    const tctx = thumb.getContext("2d");
    tctx.imageSmoothingEnabled = scale < 1;
    tctx.drawImage(layer.canvas, 0, 0, thumb.width, thumb.height);
    layer.thumbnail = thumb.toDataURL("image/png");
  }

  // Flattens the visible layers, bottom to top, into the document canvas and this.imageData. Every pixel
  // in every layer is either opaque or fully transparent, so canvas compositing is exactly "top-most
  // opaque pixel wins" with no blending or rounding.
  recomposite() {
    const bottom = this.layers[0];
    const width = bottom.imageData.width;
    const height = bottom.imageData.height;
    if (this.documentCanvas.width !== width || this.documentCanvas.height !== height) {
      this.documentCanvas.width = width;
      this.documentCanvas.height = height;
    }
    const ctx = this.documentCanvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    for (const layer of this.layers) {
      if (layer.visible) {
        ctx.drawImage(layer.canvas, 0, 0);
      }
    }
    this.imageData = ctx.getImageData(0, 0, width, height);
  }

  // Pushes the layer stack's shape (ids, visibility, thumbnails, active layer) into state for rendering.
  publishLayers() {
    this.setState({
      layerList: this.layers.map((layer) => ({ id: layer.id, visible: layer.visible, thumbnail: layer.thumbnail })),
      activeLayerId: this.activeLayerId,
      canvasWidth: this.layers[0].imageData.width,
      canvasHeight: this.layers[0].imageData.height,
    });
  }

  // Captures the layer stack as an undo-able snapshot: the array order plus each layer's visibility. Layer
  // objects (and their pixels) are shared, which is fine because pixel edits have their own history entries
  // and history is linear, so each snapshot is restored into the state its pixels were in at the time.
  snapshotLayers() {
    return { entries: this.layers.map((layer) => ({ layer, visible: layer.visible })), activeLayerId: this.activeLayerId };
  }

  restoreLayers(snapshot) {
    const sizeBefore = this.layers[0].imageData.width * 65536 + this.layers[0].imageData.height;
    this.layers = snapshot.entries.map(({ layer, visible }) => {
      layer.visible = visible;
      return layer;
    });
    this.activeLayerId = snapshot.activeLayerId;
    const sizeAfter = this.layers[0].imageData.width * 65536 + this.layers[0].imageData.height;
    if (sizeBefore !== sizeAfter) {
      this.resetSelectionForNewSize();
    }
    this.recomposite();
    this.publishLayers();
    if (sizeBefore !== sizeAfter) {
      this.zoomToFit();
    }
  }

  // Runs a structural change (add / delete / reorder / show / hide) as one undoable history entry.
  changeLayers(mutate) {
    const before = this.snapshotLayers();
    mutate();
    const after = this.snapshotLayers();
    this.pushHistory({ type: "layers", before, after });
    this.recomposite();
    this.publishLayers();
  }

  resetSelectionForNewSize() {
    const { width, height } = this.layers[0].imageData;
    this.selectionMask = new Uint8Array(width * height);
    this.selectedCountLive = 0;
    this.syncMaskCanvas();
    this.setState({ selectedCount: 0 });
  }

  onAddEmptyLayer = () => {
    this.changeLayers(() => {
      const { width, height } = this.layers[0].imageData;
      const layer = this.makeLayer(new ImageData(width, height));
      const activeIndex = this.layers.indexOf(this.activeLayer());
      this.layers.splice(activeIndex + 1, 0, layer); // directly above the active layer
      this.activeLayerId = layer.id;
    });
  };

  onDeleteLayer = (id) => {
    if (this.layers.length <= 1) {
      return; // there is always one layer
    }
    this.changeLayers(() => {
      const index = this.layers.findIndex((layer) => layer.id === id);
      const wasActive = this.layers[index].id === this.activeLayerId;
      this.layers.splice(index, 1);
      if (wasActive) {
        // the layer above takes over if there is one, otherwise the one below
        const next = this.layers[index] || this.layers[index - 1];
        this.activeLayerId = next.id;
      }
    });
  };

  onMoveLayer = (id, direction) => {
    const index = this.layers.findIndex((layer) => layer.id === id);
    const target = index + direction; // +1 is up (towards the top of the stack), -1 is down
    if (target < 0 || target >= this.layers.length) {
      return;
    }
    this.changeLayers(() => {
      const [layer] = this.layers.splice(index, 1);
      this.layers.splice(target, 0, layer);
    });
  };

  onToggleLayerVisible = (id) => {
    this.changeLayers(() => {
      const layer = this.layers.find((candidate) => candidate.id === id);
      layer.visible = !layer.visible;
    });
  };

  onActivateLayer = (id) => {
    this.activeLayerId = id;
    this.setState({ activeLayerId: id });
  };

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
    const data = this.activeLayer().imageData.data;
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
    const { width, height, data } = this.activeLayer().imageData; // samples the active layer, like most editors' bucket
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

  // Lifts the selected pixels of the composite (what you see) into a new layer directly above the active
  // one, transparent everywhere else, makes it active, and clears the selection.
  onCopySelectionToLayer = () => {
    const { width, height, data } = this.imageData;
    if (this.selectedCountLive === 0) {
      return;
    }
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < this.selectionMask.length; i++) {
      if (this.selectionMask[i]) {
        pixels.set(data.subarray(i * 4, i * 4 + 4), i * 4);
      }
    }
    const layer = this.makeLayer(new ImageData(pixels, width, height));
    this.changeLayers(() => {
      const activeIndex = this.layers.indexOf(this.activeLayer());
      this.layers.splice(activeIndex + 1, 0, layer);
      this.activeLayerId = layer.id;
    });
    this.clearSelection();
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
    this.syncLayerCanvas(this.activeLayer()); // the stroke is final: refresh the layer's canvas and thumbnail
    const indices = new Uint32Array(stroke.size);
    const before = new Uint8ClampedArray(stroke.size * 4);
    const after = new Uint8ClampedArray(stroke.size * 4);
    let k = 0;
    for (const [pixelIndex, previous] of stroke) {
      indices[k] = pixelIndex;
      before.set(previous, k * 4);
      after.set(this.activeLayer().imageData.data.subarray(pixelIndex * 4, pixelIndex * 4 + 4), k * 4);
      k++;
    }
    this.pushHistory({ type: "pixels", layerId: this.activeLayer().id, indices, before, after });
  }

  applyPixels(layerId, indices, values) {
    const layer = this.layers.find((candidate) => candidate.id === layerId);
    if (layer === undefined) {
      return; // the layer was deleted after this stroke; its deletion is its own history entry
    }
    const data = layer.imageData.data;
    for (let k = 0; k < indices.length; k++) {
      data.set(values.subarray(k * 4, k * 4 + 4), indices[k] * 4);
    }
    this.syncLayerCanvas(layer);
  }

  undo = () => {
    if (this.currentStroke !== null || this.undoStack.length === 0) {
      return;
    }
    const entry = this.undoStack.pop();
    this.redoStack.push(entry);
    if (entry.type === "pixels") {
      this.applyPixels(entry.layerId, entry.indices, entry.before);
    } else {
      this.restoreLayers(entry.before);
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
      this.applyPixels(entry.layerId, entry.indices, entry.after);
    } else {
      this.restoreLayers(entry.after);
    }
    this.afterChange();
  };

  afterChange() {
    this.recomposite();
    this.publishLayers();
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
    const opened = this.makeLayer(new ImageData(new Uint8ClampedArray(currentMaterialsData.pixelsData), width, height));
    const sizeChanged = width !== this.layers[0].imageData.width || height !== this.layers[0].imageData.height;
    this.changeLayers(() => {
      if (sizeChanged) {
        this.layers = [opened]; // layers are always the canvas size, so a new size means a fresh stack
      } else {
        this.layers.push(opened); // on top of everything
      }
      this.activeLayerId = opened.id;
    });
    if (sizeChanged) {
      this.resetSelectionForNewSize();
      this.zoomToFit();
    }
    this.setState({ openedBaseFilename: this.props.uploadedImage_baseFilename });
    if (this.detailsRef.current !== null) {
      this.detailsRef.current.open = true; // the button lives in the collapsed header too
    }
  };

  // The name of the image that was opened into the editor, falling back to the current upload.
  editedBaseFilename() {
    const base = typeof this.state.openedBaseFilename === "string" ? this.state.openedBaseFilename : this.props.uploadedImage_baseFilename;
    return base === null || base === undefined ? "mapart" : base;
  }

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
      const layer = this.activeLayer();
      layer.canvas.getContext("2d").putImageData(layer.imageData, 0, 0); // thumbnail waits for the stroke to end
      this.recomposite();
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
    if (this.state.selectionMode) {
      this.clearSelection(); // a selection only means something while you are in the mode that made it
    }
    this.setState((state) => ({ selectionMode: !state.selectionMode }));
  };

  // Puts the document on the system clipboard as a PNG at map resolution (a 1x1 map is a 128x128 image;
  // no viewport zoom involved). The ClipboardItem is handed a promise and write() is called synchronously
  // inside the click, which is what Safari needs to treat it as a user gesture. Browsers without the API
  // get the same PNG as a download instead, so the button always yields the image somewhere.
  onCopyImage = () => {
    const pngBlob = () => new Promise((resolve) => this.documentCanvas.toBlob(resolve, "image/png"));
    const fallbackDownload = async () => {
      const { downloadBlobFile } = this.props;
      downloadBlobFile(await pngBlob(), `${this.editedBaseFilename()}.png`);
      this.flashCopyStatus("downloaded");
    };
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard || typeof navigator.clipboard.write !== "function") {
      fallbackDownload();
      return;
    }
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": pngBlob() })])
      .then(() => this.flashCopyStatus("copied"))
      .catch(() => fallbackDownload());
  };

  flashCopyStatus(status) {
    clearTimeout(this.copyStatusTimer);
    this.setState({ copyStatus: status });
    this.copyStatusTimer = setTimeout(() => this.setState({ copyStatus: null }), 1800);
  }

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
    const { getLocaleString, currentMaterialsData, mapPreviewWorker_inProgress, optionValue_mapSize_x, optionValue_mapSize_y } = this.props;
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
      layerList,
      activeLayerId,
      copyStatus,
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
      <details className="section boxed imageEditorDiv" ref={this.detailsRef}>
        <summary className="imageEditorSummary">
          <h2>{getLocaleString("IMAGE-EDITOR/TITLE")}</h2>
          <Tooltip tooltipText={getLocaleString("IMAGE-EDITOR/COPY-FROM-PREVIEW-TT")}>
            <button
              className="editorToolButton imageEditorHeaderButton"
              disabled={!canCopy}
              onClick={(e) => {
                e.preventDefault(); // a click inside <summary> would otherwise toggle the panel
                e.stopPropagation();
                this.onCopyFromPreview();
              }}
            >
              {getLocaleString("IMAGE-EDITOR/COPY-FROM-PREVIEW")}
            </button>
          </Tooltip>
        </summary>
        <div className="imageEditorSubtitle">{getLocaleString("IMAGE-EDITOR/SUBTITLE")}</div>
        <div className="imageEditorSubtitle">{getLocaleString("IMAGE-EDITOR/SHORTCUTS")}</div>

        <div className="editorToolbar">
          <button
            className={`editorToolButton editorToggleButton${selectionMode ? " editorToggleButton_on" : ""}`}
            onClick={this.onToggleSelectionMode}
            aria-pressed={selectionMode}
          >
            {getLocaleString("IMAGE-EDITOR/SELECTION-MODE")}
          </button>
          {selectionMode && (
            <button className="editorToolButton" onClick={this.onCopySelectionToLayer} disabled={selectedCount === 0}>
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
              <button className="editorToolButton" onClick={this.onCopyImage} title={getLocaleString("IMAGE-EDITOR/COPY-IMAGE-TT")}>
                {copyStatus === "copied"
                  ? getLocaleString("IMAGE-EDITOR/COPY-IMAGE-DONE")
                  : copyStatus === "downloaded"
                  ? getLocaleString("IMAGE-EDITOR/COPY-IMAGE-DOWNLOADED")
                  : getLocaleString("IMAGE-EDITOR/COPY-IMAGE")}
              </button>
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

            <div className="editorLayers">
              {[...layerList].reverse().map((layer, displayIndex) => {
                const isTop = displayIndex === 0;
                const isBottom = displayIndex === layerList.length - 1;
                const isActive = layer.id === activeLayerId;
                return (
                  <div
                    key={layer.id}
                    className={`editorLayerRow${isActive ? " editorLayerRow_active" : ""}`}
                    onClick={() => this.onActivateLayer(layer.id)}
                    title={isActive ? undefined : getLocaleString("IMAGE-EDITOR/LAYER-ACTIVATE")}
                  >
                    <button
                      className="editorToolButton editorIconButton"
                      title={getLocaleString("IMAGE-EDITOR/LAYER-VISIBLE")}
                      onClick={(e) => {
                        e.stopPropagation();
                        this.onToggleLayerVisible(layer.id);
                      }}
                    >
                      {layer.visible ? ICONS.eyeOpen : ICONS.eyeClosed}
                    </button>
                    <img className={`editorLayerThumb${layer.visible ? "" : " editorLayerThumb_hidden"}`} src={layer.thumbnail} alt="" />
                    <span className="editorLayerSpacer" />
                    <button
                      className="editorToolButton editorIconButton"
                      title={getLocaleString("IMAGE-EDITOR/LAYER-DELETE")}
                      disabled={layerList.length <= 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        this.onDeleteLayer(layer.id);
                      }}
                    >
                      {ICONS.trash}
                    </button>
                    <span className="editorLayerArrows">
                      <button
                        className="editorToolButton editorIconButton editorLayerArrow"
                        title={getLocaleString("IMAGE-EDITOR/LAYER-UP")}
                        disabled={isTop}
                        onClick={(e) => {
                          e.stopPropagation();
                          this.onMoveLayer(layer.id, 1);
                        }}
                      >
                        {ICONS.chevronUp}
                      </button>
                      <button
                        className="editorToolButton editorIconButton editorLayerArrow"
                        title={getLocaleString("IMAGE-EDITOR/LAYER-DOWN")}
                        disabled={isBottom}
                        onClick={(e) => {
                          e.stopPropagation();
                          this.onMoveLayer(layer.id, -1);
                        }}
                      >
                        {ICONS.chevronDown}
                      </button>
                    </span>
                  </div>
                );
              })}
              <button className="editorToolButton editorIconButton editorLayerAdd" title={getLocaleString("IMAGE-EDITOR/LAYER-ADD")} onClick={this.onAddEmptyLayer}>
                {ICONS.plus}
              </button>
            </div>
          </div>

          <div className="editorPaletteColumn">
            <div className="editorPaletteHeading">
              <b>{getLocaleString("IMAGE-EDITOR/PALETTE")}</b>
              <small className="editorPaletteNote">{getLocaleString("IMAGE-EDITOR/PALETTE-NOTE")}</small>
            </div>
            <div className="editorPalette">
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
              {this.airAvailable && (
                <div
                  className={`editorSwatch editorSwatch_air${brushIsAir ? " editorSwatch_selected" : ""}`}
                  title={getLocaleString("IMAGE-EDITOR/AIR")}
                  onClick={() => this.setState({ brushColour: TRANSPARENT })}
                />
              )}
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

        <div className="editorDownloads">
          <b>{getLocaleString("IMAGE-EDITOR/DOWNLOAD-EDITED")}</b>
          {pixelsOutsidePalette > 0 && (
            <small className="editorWarning">{`${pixelsOutsidePalette.toString()} ${getLocaleString("IMAGE-EDITOR/OUTSIDE-PALETTE")}`}</small>
          )}
          <GreenButtons
            {...this.props}
            optionValue_mapSize_x={canvasWidth / 128}
            optionValue_mapSize_y={canvasHeight / 128}
            uploadedImage_baseFilename={this.editedBaseFilename()}
            currentMaterialsData={editorMaterialsData}
            mapPreviewWorker_inProgress={materialsWorker_inProgress || editorMaterialsData.pixelsData === null}
          />
        </div>
      </details>
    );
  }
}

export default ImageEditor;
