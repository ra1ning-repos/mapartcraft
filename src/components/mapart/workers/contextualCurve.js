// eslint-disable-next-line import/no-anonymous-default-export
// eslint-disable-next-line no-restricted-globals

export default function ContextualCurveWorker(args) {

/*
  Context-based space filling curve, after Dafner, Cohen-Or & Matias, "Context-based Space Filling
  Curves", Eurographics 2000 (https://www.math.tau.ac.il/~matias/papers/eg2000.pdf).

  Cover-and-merge: every 2x2 block of pixels starts life as its own tiny 4-cycle. Blocks are the
  vertices of a dual graph, adjacent blocks are joined by dual edges, and a minimum spanning tree of
  that dual graph is grown with Prim's algorithm. Each dual edge that enters the tree merges two
  cycles into one by swapping the two edges facing each other for the two edges that connect the
  blocks. When the tree spans every block, the merged cycles form a single Hamiltonian cycle that
  visits every pixel exactly once.

  Dual edge weights follow the paper's improved formula (their Figure 10):
      W(Ci, Cj) = |u| + |w| + |x| + |y| + |z| - |e| - |f|
  where u, w are the two connecting edges being added, x, y, z the three edges of the new block
  Cj that survive the merge, and e, f the two facing edges being removed. Edge cost is the L1 RGB
  difference of its two pixels, as in the paper. Low weight means the curve extends into a region
  of similar colour, so the finished curve tends to stay inside image regions and cross edges rarely.

  This runs as a web worker via WorkerBuilder, which stringifies the function body, so everything
  it needs is defined inside.

  Message in : { head: "GENERATE", body: { width, height, pixels: Uint8ClampedArray (RGBA) } }
  Message out: { head: "PROGRESS_REPORT", body: 0..1 } (repeatedly), then
               { head: "CURVE", body: { order: Uint32Array } } - pixel indices in traversal order.
*/

const EDGE_DOWN = 1; // this pixel is joined to the pixel below it
const EDGE_RIGHT = 2; // this pixel is joined to the pixel to its right

const DIR_NONE = 0;
const DIR_UP = 1; // the new block sits above the block it was reached from
const DIR_RIGHT = 2;
const DIR_DOWN = 3;
const DIR_LEFT = 4;

// Binary min-heap over parallel typed arrays. Capacity is fixed up front: each dual vertex is
// added to the tree exactly once and pushes at most four candidates when it is, so 4 * dualCount
// entries can never be exceeded.
function makeHeap(capacity) {
  return {
    weights: new Float32Array(capacity),
    payloads: new Int32Array(capacity),
    size: 0,
  };
}

function heapPush(heap, weight, payload) {
  let index = heap.size++;
  heap.weights[index] = weight;
  heap.payloads[index] = payload;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap.weights[parent] <= heap.weights[index]) {
      break;
    }
    const tempWeight = heap.weights[parent];
    heap.weights[parent] = heap.weights[index];
    heap.weights[index] = tempWeight;
    const tempPayload = heap.payloads[parent];
    heap.payloads[parent] = heap.payloads[index];
    heap.payloads[index] = tempPayload;
    index = parent;
  }
}

// Pops the smallest weight and returns its payload; the weight itself is not needed by the caller.
function heapPop(heap) {
  const topPayload = heap.payloads[0];
  heap.size--;
  if (heap.size > 0) {
    heap.weights[0] = heap.weights[heap.size];
    heap.payloads[0] = heap.payloads[heap.size];
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.size && heap.weights[left] < heap.weights[smallest]) {
        smallest = left;
      }
      if (right < heap.size && heap.weights[right] < heap.weights[smallest]) {
        smallest = right;
      }
      if (smallest === index) {
        break;
      }
      const tempWeight = heap.weights[smallest];
      heap.weights[smallest] = heap.weights[index];
      heap.weights[index] = tempWeight;
      const tempPayload = heap.payloads[smallest];
      heap.payloads[smallest] = heap.payloads[index];
      heap.payloads[index] = tempPayload;
      index = smallest;
    }
  }
  return topPayload;
}

function generateCurve(width, height, pixels) {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error("Contextual curve needs even dimensions");
  }
  const pixelCount = width * height;
  const dualWidth = width >> 1;
  const dualHeight = height >> 1;
  const dualCount = dualWidth * dualHeight;

  // ---- Precompute every pixel edge cost once. Each one is read by up to four dual weights.
  // horizontalCost[i]: cost between pixel i and the pixel to its right (undefined for the last column)
  // verticalCost[i]:   cost between pixel i and the pixel below it (undefined for the last row)
  const horizontalCost = new Float32Array(pixelCount);
  const verticalCost = new Float32Array(pixelCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      if (x < width - 1) {
        const q = p + 4;
        horizontalCost[i] = Math.abs(pixels[p] - pixels[q]) + Math.abs(pixels[p + 1] - pixels[q + 1]) + Math.abs(pixels[p + 2] - pixels[q + 2]);
      }
      if (y < height - 1) {
        const q = p + width * 4;
        verticalCost[i] = Math.abs(pixels[p] - pixels[q]) + Math.abs(pixels[p + 1] - pixels[q + 1]) + Math.abs(pixels[p + 2] - pixels[q + 2]);
      }
    }
  }

  // ---- Cover: every 2x2 block is its own small cycle.
  const edges = new Uint8Array(pixelCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if ((x & 1) === 0) {
        edges[i] |= EDGE_RIGHT;
      }
      if ((y & 1) === 0) {
        edges[i] |= EDGE_DOWN;
      }
    }
  }

  // Cost of the four edges of the small cycle around the block whose top-left pixel is (row, col).
  const blockTop = (row, col) => horizontalCost[row * width + col];
  const blockBottom = (row, col) => horizontalCost[(row + 1) * width + col];
  const blockLeft = (row, col) => verticalCost[row * width + col];
  const blockRight = (row, col) => verticalCost[row * width + col + 1];

  // ---- Merge: Prim's algorithm over the dual graph.
  const inTree = new Uint8Array(dualCount);
  const heap = makeHeap(4 * dualCount + 1);
  heapPush(heap, 0, 0 * 8 + DIR_NONE); // payload = dualIndex * 8 + direction

  let added = 0;
  const reportEvery = Math.max(1, Math.floor(dualCount / 200));

  while (heap.size > 0) {
    const payload = heapPop(heap);
    const dualIndex = payload >> 3;
    const direction = payload & 7;
    if (inTree[dualIndex]) {
      continue; // lazy deletion: a cheaper route already brought this block in
    }
    inTree[dualIndex] = 1;
    added++;
    if (added % reportEvery === 0) {
      postMessage({ head: "PROGRESS_REPORT", body: added / dualCount });
    }

    const dualRow = Math.floor(dualIndex / dualWidth);
    const dualCol = dualIndex - dualRow * dualWidth;
    const row = dualRow * 2; // top-left pixel of this block
    const col = dualCol * 2;

    // Merge this block's cycle into the cycle of the block we reached it from: drop the two facing
    // edges, add the two connecting edges. Written in terms of this (new) block's top-left pixel.
    switch (direction) {
      case DIR_UP: {
        // origin block is directly below: (row + 2, col)
        edges[(row + 1) * width + col] &= ~EDGE_RIGHT; // this block's bottom edge
        edges[(row + 2) * width + col] &= ~EDGE_RIGHT; // origin's top edge
        edges[(row + 1) * width + col] |= EDGE_DOWN; // two connectors
        edges[(row + 1) * width + col + 1] |= EDGE_DOWN;
        break;
      }
      case DIR_DOWN: {
        // origin block is directly above: (row - 2, col)
        edges[row * width + col] &= ~EDGE_RIGHT; // this block's top edge
        edges[(row - 1) * width + col] &= ~EDGE_RIGHT; // origin's bottom edge
        edges[(row - 1) * width + col] |= EDGE_DOWN;
        edges[(row - 1) * width + col + 1] |= EDGE_DOWN;
        break;
      }
      case DIR_RIGHT: {
        // origin block is directly left: (row, col - 2)
        edges[row * width + col] &= ~EDGE_DOWN; // this block's left edge
        edges[row * width + col - 1] &= ~EDGE_DOWN; // origin's right edge
        edges[row * width + col - 1] |= EDGE_RIGHT;
        edges[(row + 1) * width + col - 1] |= EDGE_RIGHT;
        break;
      }
      case DIR_LEFT: {
        // origin block is directly right: (row, col + 2)
        edges[row * width + col + 1] &= ~EDGE_DOWN; // this block's right edge
        edges[row * width + col + 2] &= ~EDGE_DOWN; // origin's left edge
        edges[row * width + col + 1] |= EDGE_RIGHT;
        edges[(row + 1) * width + col + 1] |= EDGE_RIGHT;
        break;
      }
      default:
        break; // the seed block has nothing to merge with
    }

    // Offer every neighbouring block not yet in the tree, weighted by the cost of merging it in
    // from here. Naming follows the paper: connectors u, w; new block's surviving edges x, y, z;
    // removed facing edges e (ours) and f (theirs).
    if (dualRow > 0 && !inTree[dualIndex - dualWidth]) {
      const nRow = row - 2;
      const u = verticalCost[(row - 1) * width + col];
      const w = verticalCost[(row - 1) * width + col + 1];
      const x = blockTop(nRow, col);
      const y = blockLeft(nRow, col);
      const z = blockRight(nRow, col);
      const e = blockTop(row, col);
      const f = blockBottom(nRow, col);
      heapPush(heap, u + w + x + y + z - e - f, (dualIndex - dualWidth) * 8 + DIR_UP);
    }
    if (dualCol < dualWidth - 1 && !inTree[dualIndex + 1]) {
      const nCol = col + 2;
      const u = horizontalCost[row * width + col + 1];
      const w = horizontalCost[(row + 1) * width + col + 1];
      const x = blockTop(row, nCol);
      const y = blockBottom(row, nCol);
      const z = blockRight(row, nCol);
      const e = blockRight(row, col);
      const f = blockLeft(row, nCol);
      heapPush(heap, u + w + x + y + z - e - f, (dualIndex + 1) * 8 + DIR_RIGHT);
    }
    if (dualRow < dualHeight - 1 && !inTree[dualIndex + dualWidth]) {
      const nRow = row + 2;
      const u = verticalCost[(row + 1) * width + col];
      const w = verticalCost[(row + 1) * width + col + 1];
      const x = blockBottom(nRow, col);
      const y = blockLeft(nRow, col);
      const z = blockRight(nRow, col);
      const e = blockBottom(row, col);
      const f = blockTop(nRow, col);
      heapPush(heap, u + w + x + y + z - e - f, (dualIndex + dualWidth) * 8 + DIR_DOWN);
    }
    if (dualCol > 0 && !inTree[dualIndex - 1]) {
      const nCol = col - 2;
      const u = horizontalCost[row * width + col - 1];
      const w = horizontalCost[(row + 1) * width + col - 1];
      const x = blockTop(row, nCol);
      const y = blockBottom(row, nCol);
      const z = blockLeft(row, nCol);
      const e = blockLeft(row, col);
      const f = blockRight(row, nCol);
      heapPush(heap, u + w + x + y + z - e - f, (dualIndex - 1) * 8 + DIR_LEFT);
    }
  }

  // ---- Walk the finished cycle from the top-left pixel. Every pixel has exactly two curve edges,
  // so from each pixel there is exactly one way forward that is not the way we came.
  const order = new Uint32Array(pixelCount);
  let previous = -1;
  let current = 0;
  for (let step = 0; step < pixelCount; step++) {
    order[step] = current;
    const x = current % width;
    let next = -1;
    if (edges[current] & EDGE_DOWN && current + width !== previous) {
      next = current + width;
    } else if (edges[current] & EDGE_RIGHT && current + 1 !== previous) {
      next = current + 1;
    } else if (x > 0 && edges[current - 1] & EDGE_RIGHT && current - 1 !== previous) {
      next = current - 1;
    } else if (current >= width && edges[current - width] & EDGE_DOWN && current - width !== previous) {
      next = current - width;
    }
    if (next === -1) {
      throw new Error(`Contextual curve broke at pixel ${current} after ${step + 1} steps`);
    }
    previous = current;
    current = next;
  }
  if (current !== 0) {
    throw new Error("Contextual curve did not close back on its start");
  }
  return order;
}

onmessage = (e) => {
  const { width, height, pixels } = e.data.body;
  const order = generateCurve(width, height, pixels);
  postMessage({ head: "CURVE", body: { order: order } }, [order.buffer]);
};

}
