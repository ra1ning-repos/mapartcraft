import React, { Component } from "react";
import { gzip } from "pako"; // blocks when zipping
import JSZip from "jszip";

import Tooltip from "../tooltip";

import MapModes from "./json/mapModes.json";
import WhereSupportBlocksModes from "./json/whereSupportBlocksModes.json";
import {
  LATE_SHADING_MODES,
  SCHEMATIC_DEFAULTS,
  SUPPRESSION_DIRECTIONS,
  connectPngToNbt,
  exactColourLookup,
  forgetBrokenPngToNbtConnection,
  generateMapTile,
  isPngToNbtConnectionFailure,
  legacyShadingMethod,
  legacyWhereSupportBlocksKey,
  mapTileColours,
  pngToNbtBlocks,
  pngToNbtLateShading,
  pngToNbtOptions,
  pngToNbtVersionKey,
  rejectedBlockColourId,
  withNamedPaletteEntries,
} from "./pngToNbt";

import WorkerBuilder from './workers/worker-builder';
import NBTWorker from "./workers/nbt";

import "./greenButtons.css";

class GreenButtons extends Component {
  // For download buttons etc
  state = {
    buttonWidth_NBT_Joined: 1,
    buttonWidth_NBT_Split: 1,
    buttonWidth_Mapdat_Split: 1,
    mapPreviewWorker_onFinishCallback: null,
    schematicNotice: null, // { tone: "info" | "warning" | "error", title?, lines } shown under the buttons
  };

  nbtWorker = new WorkerBuilder(NBTWorker);

  pngToNbtRun = 0; // bumped to abandon a PNG-to-NBT download in progress

  resetButtonWidths() {
    this.setState({
      buttonWidth_NBT_Joined: 1,
      buttonWidth_NBT_Split: 1,
      buttonWidth_Mapdat_Split: 1,
    });
  }

  // Map .dat files are either numbered from the chosen start id or named after the image. Numbered files
  // are "map_7.dat" for Minecraft up to 1.21.x and plain "7.dat" from 26.1 (snapshot 6) on, where they also
  // moved to data/minecraft/maps/ and idcounts.dat became last_id.dat.
  mapdatFilename(whichMap_x, whichMap_y) {
    const { optionValue_mapdatFilenameUseId, optionValue_mapdatFilenameIdStart, optionValue_mapdatModernNaming, optionValue_mapSize_x, uploadedImage_baseFilename } = this.props;
    if (!optionValue_mapdatFilenameUseId) {
      return `${uploadedImage_baseFilename}_${whichMap_x.toString()}_${whichMap_y.toString()}.dat`;
    }
    const id = (optionValue_mapdatFilenameIdStart + whichMap_y * optionValue_mapSize_x + whichMap_x).toString();
    return optionValue_mapdatModernNaming ? `${id}.dat` : `map_${id}.dat`;
  }

  // The built-in generator's staircase mode: off, or Classic / Valley, the only two it knows.
  legacyNBTStaircasing() {
    const { optionValue_staircasing, optionValue_schematic_shadingMethod } = this.props;
    const staircaseModes = MapModes.SCHEMATIC_NBT.staircaseModes;
    if (optionValue_staircasing === staircaseModes.OFF.uniqueId) {
      return staircaseModes.OFF.uniqueId;
    }
    return legacyShadingMethod(optionValue_schematic_shadingMethod) === "staircase_valley" ? staircaseModes.VALLEY.uniqueId : staircaseModes.CLASSIC.uniqueId;
  }

  getNBT_base = (workerHeader) => {
    const {
      getLocaleString,
      coloursJSON,
      optionValue_version,
      optionValue_mapSize_x,
      optionValue_mapSize_y,
      optionValue_staircasing,
      optionValue_schematic_support,
      optionValue_supportBlock,
      uploadedImage_baseFilename,
      currentMaterialsData,
      mapPreviewWorker_inProgress,
      downloadBlobFile,
    } = this.props;
    if (mapPreviewWorker_inProgress) {
      this.setState({ mapPreviewWorker_onFinishCallback: () => this.getNBT_base(workerHeader) });
      return;
    }
    if (Object.entries(currentMaterialsData.currentSelectedBlocks).every((elt) => elt[1] === "-1")) {
      alert(getLocaleString("DOWNLOAD/ERROR-NONE-SELECTED"));
      return;
    }
    const makingNBT = workerHeader === "CREATE_NBT_JOINED" || workerHeader === "CREATE_NBT_SPLIT";
    if (makingNBT && pngToNbtVersionKey(optionValue_version.MCVersion) !== null) {
      this.getNBT_pngToNbt(workerHeader === "CREATE_NBT_SPLIT");
      return;
    }
    this.pngToNbtRun += 1;
    this.setState({ schematicNotice: null });
    this.nbtWorker.terminate();
    this.resetButtonWidths();
    let numberOfSplitsCalculated = 0;
    let zipFile = new JSZip();
    const t0 = performance.now();
    this.nbtWorker = new WorkerBuilder(NBTWorker);
    this.nbtWorker.onmessage = (e) => {
      switch (e.data.head) {
        case "PROGRESS_REPORT_CREATE_NBT_JOINED": {
          this.setState({ buttonWidth_NBT_Joined: e.data.body });
          break;
        }
        case "PROGRESS_REPORT_CREATE_NBT_SPLIT": {
          this.setState({ buttonWidth_NBT_Split: (numberOfSplitsCalculated + e.data.body) / (optionValue_mapSize_x * optionValue_mapSize_y) });
          break;
        }
        case "PROGRESS_REPORT_CREATE_MAPDAT_SPLIT": {
          this.setState({ buttonWidth_Mapdat_Split: (numberOfSplitsCalculated + e.data.body) / (optionValue_mapSize_x * optionValue_mapSize_y) });
          break;
        }
        case "NBT_ARRAY": {
          const t1 = performance.now();
          console.log(`Created NBT by ${(t1 - t0).toString()}ms`);
          numberOfSplitsCalculated++;
          const { NBT_Array, whichMap_x, whichMap_y } = e.data.body;
          const NBT_Array_gzipped = gzip(NBT_Array);
          if (workerHeader === "CREATE_NBT_SPLIT") {
            zipFile.file(`${uploadedImage_baseFilename}_${whichMap_x}_${whichMap_y}.nbt`, NBT_Array_gzipped);
            if (numberOfSplitsCalculated === optionValue_mapSize_x * optionValue_mapSize_y) {
              zipFile.generateAsync({ type: "blob" }).then((content) => {
                downloadBlobFile(content, `${uploadedImage_baseFilename}.zip`);
              });
            }
          } else {
            const downloadBlob = new Blob([NBT_Array_gzipped], { type: "application/x-minecraft-level" });
            downloadBlobFile(downloadBlob, `${uploadedImage_baseFilename}.nbt`);
          }
          break;
        }
        case "MAPDAT_BYTES": {
          const t1 = performance.now();
          console.log(`Created Mapdat by ${(t1 - t0).toString()}ms`);
          numberOfSplitsCalculated++;
          const { Mapdat_Bytes, whichMap_x, whichMap_y } = e.data.body;
          const Mapdat_Bytes_gzipped = gzip(Mapdat_Bytes);
          const downloadBlob = new Blob([Mapdat_Bytes_gzipped], { type: "application/x-minecraft-level" });
          downloadBlobFile(downloadBlob, this.mapdatFilename(whichMap_x, whichMap_y));
          break;
        }
        case "MAPDAT_BYTES_ZIP": {
          const t1 = performance.now();
          console.log(`Created Mapdat by ${(t1 - t0).toString()}ms`);
          numberOfSplitsCalculated++;
          const { Mapdat_Bytes, whichMap_x, whichMap_y } = e.data.body;
          const Mapdat_Bytes_gzipped = gzip(Mapdat_Bytes);
          zipFile.file(
            this.mapdatFilename(whichMap_x, whichMap_y),
            Mapdat_Bytes_gzipped
          );
          if (numberOfSplitsCalculated === optionValue_mapSize_x * optionValue_mapSize_y) {
            zipFile.generateAsync({ type: "blob" }).then((content) => {
              downloadBlobFile(content, `${uploadedImage_baseFilename}.zip`);
            });
          }
          break;
        }
        default: {
          throw new Error("Unknown worker response header");
        }
      }
    };
    this.nbtWorker.postMessage({
      head: workerHeader,
      body: {
        coloursJSON: coloursJSON,
        MapModes: MapModes,
        WhereSupportBlocksModes: WhereSupportBlocksModes,
        optionValue_version: optionValue_version,
        optionValue_staircasing: makingNBT ? this.legacyNBTStaircasing() : optionValue_staircasing,
        optionValue_whereSupportBlocks: WhereSupportBlocksModes[legacyWhereSupportBlocksKey(optionValue_schematic_support)].uniqueId,
        // an empty field means the default it shows as its placeholder
        optionValue_supportBlock: optionValue_supportBlock.trim() === "" ? SCHEMATIC_DEFAULTS.supportBlock : optionValue_supportBlock,
        pixelsData: currentMaterialsData.pixelsData,
        maps: currentMaterialsData.maps,
        currentSelectedBlocks: currentMaterialsData.currentSelectedBlocks,
      },
    });
  };

  // Schematics from PNG-to-NBT, one map at a time. "Download NBT" saves each map's .nbt (a single file for a
  // 1x1 map), the split button zips them, just as the map.dat buttons do: PNG-to-NBT builds every map on its
  // own, so there is no joined schematic. Its notes for the build (supports it could not add, building at
  // the world's minimum Y, and so on) are listed under the buttons afterwards.
  getNBT_pngToNbt = async (zipped) => {
    const {
      getLocaleString,
      coloursJSON,
      optionValue_version,
      optionValue_mapSize_x,
      optionValue_mapSize_y,
      optionValue_staircasing,
      optionValue_schematic_shadingMethod,
      optionValue_schematic_lateShading,
      optionValue_schematic_layerGap,
      optionValue_schematic_latePairsGap,
      optionValue_schematic_crubTech,
      optionValue_schematic_support,
      optionValue_supportBlock,
      optionValue_schematic_shadeBlock,
      optionValue_schematic_crubTechPushableBlock,
      optionValue_schematic_suppressDirection,
      optionValue_schematic_suppressOneDirection,
      optionValue_schematic_keepReusableBlocks,
      optionValue_schematic_blockRecycling,
      uploadedImage_baseFilename,
      currentMaterialsData,
      downloadBlobFile,
    } = this.props;
    // what the preview made; the props may move on while the maps are being built
    const { pixelsData, currentSelectedBlocks } = currentMaterialsData;
    if (pixelsData === null) {
      return;
    }
    this.nbtWorker.terminate();
    this.resetButtonWidths();
    this.pngToNbtRun += 1;
    const run = this.pngToNbtRun;
    const progressKey = zipped ? "buttonWidth_NBT_Split" : "buttonWidth_NBT_Joined";
    const mapCount = optionValue_mapSize_x * optionValue_mapSize_y;
    const settings = {
      versionKey: pngToNbtVersionKey(optionValue_version.MCVersion),
      staircasing: optionValue_staircasing !== MapModes.SCHEMATIC_NBT.staircaseModes.OFF.uniqueId,
      shadingMethod: optionValue_schematic_shadingMethod,
      lateShading: optionValue_schematic_lateShading,
      layerGap: optionValue_schematic_layerGap,
      latePairsGap: optionValue_schematic_latePairsGap,
      crubTech: optionValue_schematic_crubTech,
      support: optionValue_schematic_support,
      supportBlock: optionValue_supportBlock,
      shadeBlock: optionValue_schematic_shadeBlock,
      crubTechPushableBlock: optionValue_schematic_crubTechPushableBlock,
      suppressDirection: optionValue_schematic_suppressDirection,
      suppressOneDirection: optionValue_schematic_suppressOneDirection,
      keepReusableBlocks: optionValue_schematic_keepReusableBlocks,
      blockRecycling: optionValue_schematic_blockRecycling,
    };
    const options = pngToNbtOptions(settings);
    const lateShading = pngToNbtLateShading(settings);
    const lookup = exactColourLookup(coloursJSON);
    const files = [];
    const notes = new Map(); // note -> the maps it applies to
    const addNote = (note, mapLabel) => {
      if (!notes.has(note)) {
        notes.set(note, []);
      }
      notes.get(note).push(mapLabel);
    };
    let mapLabel = null;
    this.setState({ [progressKey]: 0, schematicNotice: { tone: "info", lines: [getLocaleString("DOWNLOAD/PNG-TO-NBT/CONNECTING")] } });
    try {
      const connection = await connectPngToNbt();
      for (let whichMap_y = 0; whichMap_y < optionValue_mapSize_y; whichMap_y++) {
        for (let whichMap_x = 0; whichMap_x < optionValue_mapSize_x; whichMap_x++) {
          if (run !== this.pngToNbtRun) {
            return;
          }
          const mapIndex = whichMap_y * optionValue_mapSize_x + whichMap_x;
          const thisMap = getLocaleString("DOWNLOAD/PNG-TO-NBT/MAP").replace("{x}", whichMap_x).replace("{y}", whichMap_y);
          mapLabel = thisMap;
          if (mapCount > 1) {
            const building = getLocaleString("DOWNLOAD/PNG-TO-NBT/BUILDING").replace("{n}", mapIndex + 1).replace("{total}", mapCount);
            this.setState({ schematicNotice: { tone: "info", lines: [building] } });
          }
          const { colors, used } = mapTileColours(pixelsData, optionValue_mapSize_x, whichMap_x, whichMap_y, lookup);
          const blocks = pngToNbtBlocks(used, coloursJSON, currentSelectedBlocks, optionValue_version.MCVersion);
          const result = await generateMapTile(connection, { colors, blocks, options }, lateShading, (kind, value) =>
            addNote(this.pngToNbtAdjustmentNote(kind, value, options), thisMap)
          );
          if (run !== this.pngToNbtRun) {
            return;
          }
          // PNG-to-NBT gives a map more room between the layers when its blocks need it
          if (options.layerGap !== undefined && result.effectiveOptions !== undefined && result.effectiveOptions.layerGap > options.layerGap) {
            addNote(getLocaleString("DOWNLOAD/PNG-TO-NBT/LAYER-GAP-RAISED").replace("{gap}", result.effectiveOptions.layerGap), thisMap);
          }
          const stem = mapCount > 1 || zipped ? `${uploadedImage_baseFilename}_${whichMap_x}_${whichMap_y}` : uploadedImage_baseFilename;
          for (const file of result.files) {
            // one file per map in practice; any extras keep PNG-to-NBT's suffix ("tile-2.nbt" -> "stem-2.nbt")
            files.push({ name: result.files.length === 1 ? `${stem}.nbt` : `${stem}${file.name.replace(/^tile/, "")}`, data: withNamedPaletteEntries(file.data) });
          }
          for (const warning of result.warnings) {
            addNote(warning.message, thisMap);
          }
          this.setState({ [progressKey]: (mapIndex + 1) / mapCount });
        }
      }
      if (zipped) {
        const zipFile = new JSZip();
        for (const file of files) {
          zipFile.file(file.name, file.data);
        }
        const content = await zipFile.generateAsync({ type: "blob" });
        if (run !== this.pngToNbtRun) {
          return;
        }
        downloadBlobFile(content, `${uploadedImage_baseFilename}.zip`);
      } else {
        for (const file of files) {
          downloadBlobFile(new Blob([file.data], { type: "application/x-minecraft-level" }), file.name);
        }
      }
    } catch (error) {
      if (run !== this.pngToNbtRun) {
        return;
      }
      console.error(error);
      forgetBrokenPngToNbtConnection(error);
      this.resetButtonWidths();
      this.setState({ schematicNotice: { tone: "error", lines: this.pngToNbtErrorLines(error, mapCount > 1 ? mapLabel : null, currentSelectedBlocks) } });
      return;
    }
    // a note that holds for every map is listed once, without map names
    const lines = [...notes].map(([note, maps]) => (maps.length === mapCount ? note : `${maps.join(" · ")}: ${note}`));
    this.setState({ schematicNotice: lines.length === 0 ? null : { tone: "warning", title: getLocaleString("DOWNLOAD/PNG-TO-NBT/NOTES"), lines } });
  };

  pngToNbtAdjustmentNote(kind, value, options) {
    const { getLocaleString } = this.props;
    if (kind === "lateShading") {
      const mode = LATE_SHADING_MODES.find((entry) => entry.value === value);
      return getLocaleString("DOWNLOAD/PNG-TO-NBT/LATE-SHADING-USED").replace("{method}", getLocaleString(mode.localeKey));
    }
    const directionName = (direction) => getLocaleString(SUPPRESSION_DIRECTIONS.find((entry) => entry.value === direction).localeKey);
    return getLocaleString("DOWNLOAD/PNG-TO-NBT/DIRECTION-CHANGED").replace("{from}", directionName(options.direction)).replace("{to}", directionName(value));
  }

  pngToNbtErrorLines(error, mapLabel, selectedBlocks) {
    const { getLocaleString, coloursJSON, optionValue_version } = this.props;
    const detail = error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : String(error);
    if (isPngToNbtConnectionFailure(error)) {
      return [getLocaleString("DOWNLOAD/PNG-TO-NBT/CONNECT-FAILED"), `(${detail})`];
    }
    const colourId = rejectedBlockColourId(error);
    const colourSetEntry = colourId === null ? undefined : Object.entries(coloursJSON).find(([, colourSet]) => colourSet.mapdatId === colourId);
    if (colourSetEntry !== undefined && colourSetEntry[1].blocks[selectedBlocks[colourSetEntry[0]]] !== undefined) {
      const [colourSetId, colourSet] = colourSetEntry;
      return [
        getLocaleString("DOWNLOAD/PNG-TO-NBT/BLOCK-REJECTED")
          .replace("{block}", colourSet.blocks[selectedBlocks[colourSetId]].displayName)
          .replace("{colour}", colourSet.colourName)
          .replace("{version}", optionValue_version.MCVersion),
      ];
    }
    return [getLocaleString("DOWNLOAD/PNG-TO-NBT/FAILED"), mapLabel === null ? detail : `${mapLabel}: ${detail}`];
  }

  onGetNBTClicked = () => {
    this.getNBT_base("CREATE_NBT_JOINED");
  };

  onGetNBTSplitClicked = () => {
    this.getNBT_base("CREATE_NBT_SPLIT");
  };

  onGetMapdatSplitClicked = () => {
    this.getNBT_base("CREATE_MAPDAT_SPLIT");
  };

  onGetMapdatSplitZipClicked = () => {
    this.getNBT_base("CREATE_MAPDAT_SPLIT_ZIP");
  };

  componentDidUpdate_shouldNBTWorkerTerminate(prevProps) {
    const {
      selectedBlocks,
      optionValue_version,
      optionValue_modeNBTOrMapdat,
      optionValue_mapSize_x,
      optionValue_mapSize_y,
      optionValue_cropImage,
      optionValue_cropImage_zoom,
      optionValue_cropImage_percent_x,
      optionValue_cropImage_percent_y,
      optionValue_downscaleMethod,
      optionValue_gammaCorrectAveraging,
      optionValue_staircasing,
      optionValue_schematic_shadingMethod,
      optionValue_schematic_lateShading,
      optionValue_schematic_layerGap,
      optionValue_schematic_latePairsGap,
      optionValue_schematic_crubTech,
      optionValue_schematic_support,
      optionValue_supportBlock,
      optionValue_schematic_shadeBlock,
      optionValue_schematic_crubTechPushableBlock,
      optionValue_schematic_suppressDirection,
      optionValue_schematic_suppressOneDirection,
      optionValue_schematic_keepReusableBlocks,
      optionValue_schematic_blockRecycling,
      optionValue_transparency,
      optionValue_transparencyTolerance,
      optionValue_mapdatFilenameUseId,
      optionValue_mapdatFilenameIdStart,
      optionValue_mapdatModernNaming,
      optionValue_betterColour,
      optionValue_dithering,
      optionValue_dithering_propagation_red,
      optionValue_dithering_propagation_green,
      optionValue_dithering_propagation_blue,
      optionValue_dithering_boustrophedon,
      preProcessingValue_brightness,
      preProcessingValue_contrast,
      preProcessingValue_saturation,
      preProcessingValue_blackPoint,
      preProcessingValue_whitePoint,
      preProcessingValue_gamma,
      preProcessingValue_sharpness,
      preProcessingValue_noiseReduction,
      preProcessingValue_vibrance,
      preProcessingValue_warmth,
      preProcessingValue_backgroundColourSelect,
      preProcessingValue_backgroundColour,
      uploadedImage,
    } = this.props;
    return [
      prevProps.selectedBlocks !== selectedBlocks,
      prevProps.optionValue_version !== optionValue_version,
      prevProps.optionValue_modeNBTOrMapdat !== optionValue_modeNBTOrMapdat,
      prevProps.optionValue_mapSize_x !== optionValue_mapSize_x,
      prevProps.optionValue_mapSize_y !== optionValue_mapSize_y,
      prevProps.optionValue_cropImage !== optionValue_cropImage,
      prevProps.optionValue_cropImage_zoom !== optionValue_cropImage_zoom,
      prevProps.optionValue_cropImage_percent_x !== optionValue_cropImage_percent_x,
      prevProps.optionValue_cropImage_percent_y !== optionValue_cropImage_percent_y,
      prevProps.optionValue_downscaleMethod !== optionValue_downscaleMethod,
      prevProps.optionValue_gammaCorrectAveraging !== optionValue_gammaCorrectAveraging,
      prevProps.optionValue_staircasing !== optionValue_staircasing,
      prevProps.optionValue_schematic_shadingMethod !== optionValue_schematic_shadingMethod,
      prevProps.optionValue_schematic_lateShading !== optionValue_schematic_lateShading,
      prevProps.optionValue_schematic_layerGap !== optionValue_schematic_layerGap,
      prevProps.optionValue_schematic_latePairsGap !== optionValue_schematic_latePairsGap,
      prevProps.optionValue_schematic_crubTech !== optionValue_schematic_crubTech,
      prevProps.optionValue_schematic_support !== optionValue_schematic_support,
      prevProps.optionValue_supportBlock !== optionValue_supportBlock,
      prevProps.optionValue_schematic_shadeBlock !== optionValue_schematic_shadeBlock,
      prevProps.optionValue_schematic_crubTechPushableBlock !== optionValue_schematic_crubTechPushableBlock,
      prevProps.optionValue_schematic_suppressDirection !== optionValue_schematic_suppressDirection,
      prevProps.optionValue_schematic_suppressOneDirection !== optionValue_schematic_suppressOneDirection,
      prevProps.optionValue_schematic_keepReusableBlocks !== optionValue_schematic_keepReusableBlocks,
      prevProps.optionValue_schematic_blockRecycling !== optionValue_schematic_blockRecycling,
      prevProps.optionValue_transparency !== optionValue_transparency,
      prevProps.optionValue_transparencyTolerance !== optionValue_transparencyTolerance,
      prevProps.optionValue_mapdatFilenameUseId !== optionValue_mapdatFilenameUseId,
      prevProps.optionValue_mapdatFilenameIdStart !== optionValue_mapdatFilenameIdStart,
      prevProps.optionValue_mapdatModernNaming !== optionValue_mapdatModernNaming,
      prevProps.optionValue_betterColour !== optionValue_betterColour,
      prevProps.optionValue_dithering !== optionValue_dithering,
      prevProps.optionValue_dithering_propagation_red !== optionValue_dithering_propagation_red,
      prevProps.optionValue_dithering_propagation_green !== optionValue_dithering_propagation_green,
      prevProps.optionValue_dithering_propagation_blue !== optionValue_dithering_propagation_blue,
      prevProps.optionValue_dithering_boustrophedon !== optionValue_dithering_boustrophedon,
      prevProps.preProcessingValue_brightness !== preProcessingValue_brightness,
      prevProps.preProcessingValue_contrast !== preProcessingValue_contrast,
      prevProps.preProcessingValue_saturation !== preProcessingValue_saturation,
      prevProps.preProcessingValue_blackPoint !== preProcessingValue_blackPoint,
      prevProps.preProcessingValue_whitePoint !== preProcessingValue_whitePoint,
      prevProps.preProcessingValue_gamma !== preProcessingValue_gamma,
      prevProps.preProcessingValue_sharpness !== preProcessingValue_sharpness,
      prevProps.preProcessingValue_noiseReduction !== preProcessingValue_noiseReduction,
      prevProps.preProcessingValue_vibrance !== preProcessingValue_vibrance,
      prevProps.preProcessingValue_warmth !== preProcessingValue_warmth,
      prevProps.preProcessingValue_backgroundColourSelect !== preProcessingValue_backgroundColourSelect,
      prevProps.preProcessingValue_backgroundColour !== preProcessingValue_backgroundColour,
      prevProps.uploadedImage !== uploadedImage,
    ].some((elt) => elt);
  }

  componentDidUpdate(prevProps) {
    const { mapPreviewWorker_inProgress } = this.props;
    if (this.componentDidUpdate_shouldNBTWorkerTerminate(prevProps)) {
      // reset callback if setting changed; notes about the last schematic no longer apply either
      this.nbtWorker.terminate();
      this.pngToNbtRun += 1;
      this.resetButtonWidths();
      this.setState({ mapPreviewWorker_onFinishCallback: null, schematicNotice: null });
    } else if (!mapPreviewWorker_inProgress && this.state.mapPreviewWorker_onFinishCallback !== null) {
      this.state.mapPreviewWorker_onFinishCallback();
      this.setState({ mapPreviewWorker_onFinishCallback: null });
    }
  }

  componentWillUnmount() {
    this.nbtWorker.terminate();
    this.pngToNbtRun += 1;
  }

  render() {
    const { buttonWidth_NBT_Joined, buttonWidth_NBT_Split, buttonWidth_Mapdat_Split, schematicNotice } = this.state;
    const { getLocaleString, optionValue_modeNBTOrMapdat, optionValue_version, optionValue_mapSize_x, optionValue_mapSize_y } = this.props;
    const nbtPerMap = pngToNbtVersionKey(optionValue_version.MCVersion) !== null && optionValue_mapSize_x * optionValue_mapSize_y > 1;
    let buttons_mapModeConditional;
    // dummy text used in divs with absolutely positioned children to create correct container height
    if (optionValue_modeNBTOrMapdat === MapModes.SCHEMATIC_NBT.uniqueId) {
      buttons_mapModeConditional = (
        <React.Fragment>
          <Tooltip tooltipText={getLocaleString(nbtPerMap ? "DOWNLOAD/PNG-TO-NBT/DOWNLOAD-PER-MAP-TT" : "DOWNLOAD/NBT-SPECIFIC/DOWNLOAD-TT")}>
            <div className="greenButton" onClick={this.onGetNBTClicked}>
              <span className="greenButton_large_text_dummy">{getLocaleString("DOWNLOAD/NBT-SPECIFIC/DOWNLOAD")}</span>
              <span className="greenButton_large_text">{getLocaleString("DOWNLOAD/NBT-SPECIFIC/DOWNLOAD")}</span>
              <div
                className="greenButton_progressDiv"
                style={{
                  width: `${Math.floor(buttonWidth_NBT_Joined * 100)}%`,
                }}
              />
            </div>
          </Tooltip>
          <br />
          <Tooltip tooltipText={getLocaleString("DOWNLOAD/NBT-SPECIFIC/DOWNLOAD-SPLIT-TT")}>
            <div className="greenButton" onClick={this.onGetNBTSplitClicked}>
              <span className="greenButton_text_dummy">{`${getLocaleString("DOWNLOAD/NBT-SPECIFIC/DOWNLOAD-SPLIT")} .ZIP`}</span>
              <span className="greenButton_text">{`${getLocaleString("DOWNLOAD/NBT-SPECIFIC/DOWNLOAD-SPLIT")} .ZIP`}</span>
              <div
                className="greenButton_progressDiv"
                style={{
                  width: `${Math.floor(buttonWidth_NBT_Split * 100)}%`,
                }}
              />
            </div>
          </Tooltip>
          <br />
        </React.Fragment>
      );
    } else {
      buttons_mapModeConditional = (
        <React.Fragment>
          <Tooltip tooltipText={getLocaleString("DOWNLOAD/MAPDAT-SPECIFIC/DOWNLOAD-TT")}>
            <div className="greenButton" onClick={this.onGetMapdatSplitClicked}>
              <span className="greenButton_large_text_dummy">{`${getLocaleString("DOWNLOAD/MAPDAT-SPECIFIC/DOWNLOAD")}`}</span>
              <span className="greenButton_large_text">{`${getLocaleString("DOWNLOAD/MAPDAT-SPECIFIC/DOWNLOAD")}`}</span>
              <div
                className="greenButton_progressDiv"
                style={{
                  width: `${Math.floor(buttonWidth_Mapdat_Split * 100)}%`,
                }}
              />
            </div>
          </Tooltip>
          <br />
          <Tooltip tooltipText={getLocaleString("DOWNLOAD/MAPDAT-SPECIFIC/DOWNLOAD-TT")}>
            <div className="greenButton" onClick={this.onGetMapdatSplitZipClicked}>
              <span className="greenButton_large_text_dummy">{`${getLocaleString("DOWNLOAD/MAPDAT-SPECIFIC/DOWNLOAD")} .ZIP`}</span>
              <span className="greenButton_large_text">{`${getLocaleString("DOWNLOAD/MAPDAT-SPECIFIC/DOWNLOAD")} .ZIP`}</span>
              <div
                className="greenButton_progressDiv"
                style={{
                  width: `${Math.floor(buttonWidth_Mapdat_Split * 100)}%`,
                }}
              />
            </div>
          </Tooltip>
          <br />
        </React.Fragment>
      );
    }
    const buttonsDiv = (
      <div>
        {buttons_mapModeConditional}
        {schematicNotice !== null && (
          <div className={`schematicNotice schematicNotice_${schematicNotice.tone}`}>
            {schematicNotice.title !== undefined && <b>{schematicNotice.title}</b>}
            {schematicNotice.lines.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        )}
      </div>
    );
    return buttonsDiv;
  }
}

export default GreenButtons;
