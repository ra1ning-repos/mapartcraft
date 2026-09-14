// eslint-disable-next-line import/no-anonymous-default-export
// eslint-disable-next-line no-restricted-globals

export default function ResampleWorker(args) {

/*
  Deterministic resampling of an RGBA region, independent of the browser's drawImage() heuristics.

  Per axis:
    - enlarging  -> nearest neighbour, always. Every output pixel is an exact copy of one source pixel, so
                    no colours are invented and hard edges stay hard. Integer factors give perfect n x n blocks.
    - shrinking  -> the user's choice of downscaleMethod:
        "box"      area average. Every output pixel is the exact mean of the source area it covers. An edge
                   on an output pixel boundary stays hard; one inside a pixel yields exactly one intermediate
                   value (true coverage). Never aliases, never rings; pixel art shrunk by an integer factor
                   is reproduced exactly.
        "lanczos3" windowed sinc over a 6-sample-wide (in output pixels) window. Sharper than box - edges keep
                   more of their contrast and thin detail survives better - at the cost of ringing: a faint
                   overshoot on either side of strong edges, which a dither will render as speckle.
        "point"    nearest neighbour while shrinking. Aliases badly on photographs, but for pixel art that was
                   scaled to a non-integer size it snaps each output pixel back to a single source colour
                   instead of blending neighbours.

  gammaCorrect: sRGB byte values are not proportional to light, so averaging them directly darkens fine
  high-contrast texture (a black/white checkerboard averages to 128 in sRGB where the perceptually correct
  mid-grey is ~187). With gammaCorrect on, channels are decoded to linear light before averaging and
  re-encoded afterwards. It only affects box and lanczos3, since point and nearest never average.

  Averaging is done on alpha-premultiplied values so transparent pixels never bleed their (meaningless)
  RGB into their neighbours. Everything is separable: a horizontal pass over the source rows, then a
  vertical pass over the intermediate, which keeps the cost O(source pixels + output pixels).

  All inputs are plain numbers and typed arrays so this can run anywhere, including a worker or Node.

  The worker keeps the full-resolution source pixels once ("SOURCE"), so each subsequent "RESAMPLE" request
  only needs the rectangle and the output size, and only the small result crosses back to the main thread.

  Messages in : { head: "SOURCE",   body: { width, height, data: Uint8ClampedArray } }
               { head: "RESAMPLE", body: { requestId, sourceX, sourceY, sourceWidth, sourceHeight, outputWidth, outputHeight,
                                            downscaleMethod: "box" | "lanczos3" | "point", gammaCorrect: boolean } }
  Message out : { head: "RESAMPLED", body: { requestId, width, height, data, methodX, methodY, scaleX, scaleY, gammaCorrect } }
*/

  // For one axis, precompute how each of the `outputSize` output samples is built from the source span
  // [offset, offset + inputSize). Returns { kind, starts, counts, weights } where sample i uses source
  // indices starts[i] .. starts[i] + counts[i] - 1 with weights weights[weightOffset[i] + k].
  function lanczos3(x) {
    if (x === 0) {
      return 1;
    }
    const ax = Math.abs(x);
    if (ax >= 3) {
      return 0;
    }
    const px = Math.PI * x;
    return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
  }

  function planAxis(offset, inputSize, outputSize, downscaleMethod) {
    const starts = new Int32Array(outputSize);
    const counts = new Int32Array(outputSize);
    const weightOffsets = new Int32Array(outputSize);
    if (outputSize >= inputSize || downscaleMethod === "point") {
      // nearest neighbour: sample the source pixel under each output pixel's centre
      const weights = new Float32Array(outputSize);
      for (let i = 0; i < outputSize; i++) {
        starts[i] = offset + Math.min(Math.floor(((i + 0.5) * inputSize) / outputSize), inputSize - 1);
        counts[i] = 1;
        weightOffsets[i] = i;
        weights[i] = 1;
      }
      return { kind: outputSize >= inputSize ? "nearest" : "point", starts, counts, weightOffsets, weights, scale: outputSize / inputSize };
    }
    const span = inputSize / outputSize; // source pixels per output pixel
    if (downscaleMethod === "lanczos3") {
      // windowed sinc: for output i, centred at source coordinate (i + 0.5) * span - 0.5, reaching 3 output pixels
      // either side (3 * span source pixels). Weights are normalised so each output pixel's sum is exactly 1.
      const weightList = [];
      for (let i = 0; i < outputSize; i++) {
        const centre = (i + 0.5) * span - 0.5;
        const first = Math.max(0, Math.ceil(centre - 3 * span));
        const last = Math.min(inputSize - 1, Math.floor(centre + 3 * span));
        starts[i] = offset + first;
        counts[i] = last - first + 1;
        weightOffsets[i] = weightList.length;
        let sum = 0;
        for (let j = first; j <= last; j++) {
          const w = lanczos3((j - centre) / span);
          weightList.push(w);
          sum += w;
        }
        for (let k = weightOffsets[i]; k < weightList.length; k++) {
          weightList[k] /= sum;
        }
      }
      return { kind: "lanczos3", starts, counts, weightOffsets, weights: Float32Array.from(weightList), scale: outputSize / inputSize };
    }
    // area average: each output pixel spans inputSize / outputSize source pixels
    const weightList = [];
    for (let i = 0; i < outputSize; i++) {
      const begin = i * span;
      const end = begin + span;
      const first = Math.floor(begin);
      const last = Math.min(Math.ceil(end) - 1, inputSize - 1);
      starts[i] = offset + first;
      counts[i] = last - first + 1;
      weightOffsets[i] = weightList.length;
      for (let j = first; j <= last; j++) {
        const overlap = Math.min(end, j + 1) - Math.max(begin, j);
        weightList.push(overlap / span);
      }
    }
    return { kind: "box", starts, counts, weightOffsets, weights: Float32Array.from(weightList), scale: outputSize / inputSize };
  }

  /**
   * Resample the rectangle (sourceX, sourceY, sourceWidth, sourceHeight) of `source` to outputWidth x outputHeight.
   * @param {{width:number, height:number, data:Uint8ClampedArray}} source RGBA pixels
   * @returns {{data: Uint8ClampedArray, width: number, height: number, methodX: string, methodY: string, scaleX: number, scaleY: number}}
   */
  // sRGB byte -> linear light, kept on a 0..255 scale so the rest of the maths is unchanged
  const toLinear255 = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const c = v / 255;
    toLinear255[v] = 255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  }
  function toSRGB255(linear255) {
    const c = Math.max(0, linear255 / 255);
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  }

  function resampleRegion(source, sourceX, sourceY, sourceWidth, sourceHeight, outputWidth, outputHeight, downscaleMethod, gammaCorrect) {
    // keep the rectangle inside the image and at least one pixel
    sourceX = Math.max(0, Math.min(Math.floor(sourceX), source.width - 1));
    sourceY = Math.max(0, Math.min(Math.floor(sourceY), source.height - 1));
    sourceWidth = Math.max(1, Math.min(Math.floor(sourceWidth), source.width - sourceX));
    sourceHeight = Math.max(1, Math.min(Math.floor(sourceHeight), source.height - sourceY));

    const planX = planAxis(sourceX, sourceWidth, outputWidth, downscaleMethod);
    const planY = planAxis(sourceY, sourceHeight, outputHeight, downscaleMethod);
    // gamma correction only matters when something is actually being averaged
    const linearLight = gammaCorrect && (planX.kind === "box" || planX.kind === "lanczos3" || planY.kind === "box" || planY.kind === "lanczos3");
    const src = source.data;
    const srcWidth = source.width;

    // Horizontal pass: every source row in the rectangle -> outputWidth premultiplied samples
    const mid = new Float32Array(outputWidth * sourceHeight * 4);
    for (let row = 0; row < sourceHeight; row++) {
      const srcRow = (sourceY + row) * srcWidth;
      const midRow = row * outputWidth;
      for (let i = 0; i < outputWidth; i++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        const start = planX.starts[i];
        const count = planX.counts[i];
        const weightOffset = planX.weightOffsets[i];
        for (let k = 0; k < count; k++) {
          const p = (srcRow + start + k) * 4;
          const w = planX.weights[weightOffset + k];
          const alpha = src[p + 3] * w;
          if (linearLight) {
            r += toLinear255[src[p]] * alpha;
            g += toLinear255[src[p + 1]] * alpha;
            b += toLinear255[src[p + 2]] * alpha;
          } else {
            r += src[p] * alpha;
            g += src[p + 1] * alpha;
            b += src[p + 2] * alpha;
          }
          a += alpha;
        }
        const m = (midRow + i) * 4;
        mid[m] = r;
        mid[m + 1] = g;
        mid[m + 2] = b;
        mid[m + 3] = a;
      }
    }

    // Vertical pass: outputWidth columns of sourceHeight samples -> outputHeight, then un-premultiply
    const out = new Uint8ClampedArray(outputWidth * outputHeight * 4);
    for (let j = 0; j < outputHeight; j++) {
      const start = planY.starts[j] - sourceY; // mid rows are relative to the rectangle
      const count = planY.counts[j];
      const weightOffset = planY.weightOffsets[j];
      for (let i = 0; i < outputWidth; i++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let k = 0; k < count; k++) {
          const m = ((start + k) * outputWidth + i) * 4;
          const w = planY.weights[weightOffset + k];
          r += mid[m] * w;
          g += mid[m + 1] * w;
          b += mid[m + 2] * w;
          a += mid[m + 3] * w;
        }
        const o = (j * outputWidth + i) * 4;
        if (a > 0) {
          if (linearLight) {
            out[o] = toSRGB255(r / a);
            out[o + 1] = toSRGB255(g / a);
            out[o + 2] = toSRGB255(b / a);
          } else {
            out[o] = r / a;
            out[o + 1] = g / a;
            out[o + 2] = b / a;
          }
          out[o + 3] = a;
        }
      }
    }

    return {
      data: out,
      width: outputWidth,
      height: outputHeight,
      methodX: planX.kind,
      methodY: planY.kind,
      scaleX: planX.scale,
      scaleY: planY.scale,
      gammaCorrect: linearLight,
    };
  }

  let source = null;

  onmessage = (e) => {
    switch (e.data.head) {
      case "SOURCE": {
        source = e.data.body;
        break;
      }
      case "RESAMPLE": {
        if (source === null) {
          throw new Error("Resample requested before the source image was supplied");
        }
        const { requestId, sourceX, sourceY, sourceWidth, sourceHeight, outputWidth, outputHeight, downscaleMethod, gammaCorrect } = e.data.body;
        const result = resampleRegion(source, sourceX, sourceY, sourceWidth, sourceHeight, outputWidth, outputHeight, downscaleMethod, gammaCorrect === true);
        postMessage({ head: "RESAMPLED", body: { requestId: requestId, ...result } }, [result.data.buffer]);
        break;
      }
      default:
        throw new Error("Unknown header message");
    }
  };

}
