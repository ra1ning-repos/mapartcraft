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

const HISTORY_LIMIT = 200;
const MATERIALS_DEBOUNCE_MS = 400;

class ImageEditor extends Component {
  state = {
    tool: TOOL_BRUSH,
    brushColour: null, // [r, g, b] or null before anything has been picked
    editorSizeScale: 3,
    canvasWidth: 128,
    canvasHeight: 128,
    undoDepth: 0,
    redoDepth: 0,
    editorMaterialsData: { pixelsData: null, maps: null, currentSelectedBlocks: null },
    materialsWorker_inProgress: false,
    pixelsOutsidePalette: 0,
    revision: 0, // bumped on every change so the palette/warnings re-render
  };

  canvasRef = React.createRef();
  imageData = null; // ImageData; the single source of truth for the picture
  undoStack = [];
  redoStack = [];
  currentStroke = null; // Map<pixelIndex, [r, g, b, a] before> while the mouse is down
  lastPaintedPixel = null;
  materialsWorker = null;
  materialsTimer = null;
  unmounted = false;

  componentDidMount() {
    this.imageData = new ImageData(this.state.canvasWidth, this.state.canvasHeight);
    this.redraw();
    window.addEventListener("mouseup", this.onWindowMouseUp);
    window.addEventListener("keydown", this.onKeyDown);
    this.scheduleMaterials();
  }

  componentDidUpdate(prevProps) {
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

  componentWillUnmount() {
    this.unmounted = true;
    window.removeEventListener("mouseup", this.onWindowMouseUp);
    window.removeEventListener("keydown", this.onKeyDown);
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
          continue; // the transparency placeholder colour set is not paintable
        }
        palette.push({ colourSetId, toneKey, rgb, blockName: coloursJSON[colourSetId].blocks[selectedBlocks[colourSetId]].displayName });
      }
    }
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
      if (data[i + 3] !== 0 && !allowed.has(this.paletteKey(data[i], data[i + 1], data[i + 2]))) {
        count++;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------- drawing

  redraw() {
    const canvas = this.canvasRef.current;
    if (canvas === null || this.imageData === null) {
      return;
    }
    canvas.getContext("2d").putImageData(this.imageData, 0, 0);
  }

  pixelIndexFromEvent(e) {
    const canvas = this.canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * this.imageData.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * this.imageData.height);
    if (x < 0 || y < 0 || x >= this.imageData.width || y >= this.imageData.height) {
      return null;
    }
    return y * this.imageData.width + x;
  }

  // Writes one pixel, remembering its previous value in the current stroke the first time it is touched.
  setPixel(pixelIndex, rgb) {
    const data = this.imageData.data;
    const i = pixelIndex * 4;
    if (data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2] && data[i + 3] === 255) {
      return;
    }
    if (this.currentStroke !== null && !this.currentStroke.has(pixelIndex)) {
      this.currentStroke.set(pixelIndex, [data[i], data[i + 1], data[i + 2], data[i + 3]]);
    }
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }

  // Bresenham between two pixel indices so a fast drag leaves an unbroken line.
  paintLine(fromIndex, toIndex, rgb) {
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
      this.setPixel(y0 * width + x0, rgb);
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
  floodFill(startIndex, rgb) {
    const { width, height, data } = this.imageData;
    const s = startIndex * 4;
    const target = [data[s], data[s + 1], data[s + 2], data[s + 3]];
    if (target[0] === rgb[0] && target[1] === rgb[1] && target[2] === rgb[2] && target[3] === 255) {
      return;
    }
    const visited = new Uint8Array(width * height);
    const stack = [startIndex];
    visited[startIndex] = 1;
    while (stack.length > 0) {
      const index = stack.pop();
      this.setPixel(index, rgb);
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
    this.imageData = new ImageData(new Uint8ClampedArray(snapshot.data), snapshot.width, snapshot.height);
    this.setState({ canvasWidth: snapshot.width, canvasHeight: snapshot.height }, () => this.redraw());
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

  onCanvasMouseDown = (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    const pixelIndex = this.pixelIndexFromEvent(e);
    if (pixelIndex === null) {
      return;
    }
    const { tool, brushColour } = this.state;
    const data = this.imageData.data;
    if (tool === TOOL_EYEDROPPER) {
      const i = pixelIndex * 4;
      if (data[i + 3] !== 0) {
        this.setState({ brushColour: [data[i], data[i + 1], data[i + 2]] });
      }
      return;
    }
    if (brushColour === null) {
      return;
    }
    this.currentStroke = new Map();
    if (tool === TOOL_BUCKET) {
      this.floodFill(pixelIndex, brushColour);
      this.finishStroke();
      return;
    }
    this.setPixel(pixelIndex, brushColour);
    this.lastPaintedPixel = pixelIndex;
    this.redraw();
  };

  onCanvasMouseMove = (e) => {
    if (this.currentStroke === null || this.state.tool !== TOOL_BRUSH) {
      return;
    }
    const pixelIndex = this.pixelIndexFromEvent(e);
    if (pixelIndex === null) {
      return;
    }
    if (this.lastPaintedPixel === null) {
      this.setPixel(pixelIndex, this.state.brushColour);
    } else if (pixelIndex !== this.lastPaintedPixel) {
      this.paintLine(this.lastPaintedPixel, pixelIndex, this.state.brushColour);
    }
    this.lastPaintedPixel = pixelIndex;
    this.redraw();
  };

  onWindowMouseUp = () => {
    if (this.currentStroke !== null) {
      this.finishStroke();
    }
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

  changeScale = (delta) => {
    this.setState((state) => ({ editorSizeScale: Math.min(Math.max(state.editorSizeScale + delta, 1), 8) }));
  };

  render() {
    const { getLocaleString, currentMaterialsData, mapPreviewWorker_inProgress, optionValue_mapSize_x, optionValue_mapSize_y, uploadedImage_baseFilename } = this.props;
    const { tool, brushColour, editorSizeScale, canvasWidth, canvasHeight, undoDepth, redoDepth, editorMaterialsData, materialsWorker_inProgress, pixelsOutsidePalette } =
      this.state;
    const palette = this.getPalette();
    const brushKey = brushColour === null ? null : this.paletteKey(brushColour[0], brushColour[1], brushColour[2]);
    const canCopy = !mapPreviewWorker_inProgress && currentMaterialsData.pixelsData !== null && currentMaterialsData.pixelsData.length === 128 * optionValue_mapSize_x * 128 * optionValue_mapSize_y * 4;

    const toolButton = (toolId, labelKey) => (
      <button className={`editorToolButton${tool === toolId ? " editorToolButton_active" : ""}`} onClick={() => this.setState({ tool: toolId })}>
        {getLocaleString(`IMAGE-EDITOR/${labelKey}`)}
      </button>
    );
    const brushSwatchEntry = brushKey === null ? undefined : palette.find(({ rgb }) => this.paletteKey(rgb[0], rgb[1], rgb[2]) === brushKey);

    return (
      <details className="section boxed imageEditorDiv">
        <summary className="imageEditorSummary">
          <h2>{getLocaleString("IMAGE-EDITOR/TITLE")}</h2>
          <div className="imageEditorSubtitle">{getLocaleString("IMAGE-EDITOR/SUBTITLE")}</div>
        </summary>

        <div className="editorToolbar">
          <Tooltip tooltipText={getLocaleString("IMAGE-EDITOR/COPY-FROM-PREVIEW-TT")}>
            <button className="editorToolButton" onClick={this.onCopyFromPreview} disabled={!canCopy}>
              {getLocaleString("IMAGE-EDITOR/COPY-FROM-PREVIEW")}
            </button>
          </Tooltip>
          <span className="editorToolbarSpacer" />
          {toolButton(TOOL_BRUSH, "BRUSH")}
          {toolButton(TOOL_BUCKET, "BUCKET")}
          {toolButton(TOOL_EYEDROPPER, "EYEDROPPER")}
          <span
            className={`editorSwatch editorActiveSwatch${brushColour === null ? " editorActiveSwatch_empty" : ""}`}
            title={brushSwatchEntry === undefined ? undefined : `${brushSwatchEntry.blockName} (${brushSwatchEntry.toneKey})`}
            style={brushColour === null ? undefined : { backgroundColor: `rgb(${brushColour[0]}, ${brushColour[1]}, ${brushColour[2]})` }}
          />
        </div>

        <div className="editorBody">
          <div>
            <canvas
              className="editorCanvas"
              width={canvasWidth}
              height={canvasHeight}
              ref={this.canvasRef}
              style={{
                width: `${(editorSizeScale * canvasWidth).toString()}px`,
                height: `${(editorSizeScale * canvasHeight).toString()}px`,
                cursor: tool === TOOL_EYEDROPPER ? "copy" : "crosshair",
              }}
              onMouseDown={this.onCanvasMouseDown}
              onMouseMove={this.onCanvasMouseMove}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div className="mapResolutionAndZoom">
              <small>{`${canvasWidth.toString()}x${canvasHeight.toString()}`}</small>
              <div>
                <img
                  alt="+"
                  className="sizeButton"
                  src={IMG_Null}
                  style={{ backgroundImage: `url(${IMG_Textures})`, backgroundPositionX: "-96px", backgroundPositionY: "-2048px" }}
                  onClick={() => this.changeScale(1)}
                />
                <img
                  alt="-"
                  className="sizeButton"
                  src={IMG_Null}
                  style={{ backgroundImage: `url(${IMG_Textures})`, backgroundPositionX: "-128px", backgroundPositionY: "-2048px" }}
                  onClick={() => this.changeScale(-1)}
                />
              </div>
            </div>
          </div>

          <div className="editorPaletteColumn">
            <div>
              <b>{getLocaleString("IMAGE-EDITOR/PALETTE")}</b> <small className="editorPaletteNote">{getLocaleString("IMAGE-EDITOR/PALETTE-NOTE")}</small>
            </div>
            <div className="editorPalette">
              {palette.map(({ colourSetId, toneKey, rgb, blockName }) => {
                const key = this.paletteKey(rgb[0], rgb[1], rgb[2]);
                return (
                  <div
                    key={`${colourSetId}_${toneKey}`}
                    className={`editorSwatch${key === brushKey ? " editorSwatch_selected" : ""}`}
                    title={`${blockName} (${toneKey})`}
                    style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
                    onClick={() => this.setState({ brushColour: rgb })}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <div className="editorHistoryButtons">
          <button className="editorToolButton" onClick={this.undo} disabled={undoDepth === 0} title={getLocaleString("IMAGE-EDITOR/UNDO")}>
            {"\u21b6"}
          </button>
          <button className="editorToolButton" onClick={this.redo} disabled={redoDepth === 0} title={getLocaleString("IMAGE-EDITOR/REDO")}>
            {"\u21b7"}
          </button>
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
