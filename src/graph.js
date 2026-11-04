// Lane layout for a commit graph, like `git log --graph` but as drawable segments.
// Input: commits in topological order (newest first), each { hash, parents: [hash...] }.
// Output per commit: { col, color, segments } where a segment joins (x1, y1) to (x2, y2)
// in lane units: x is the lane index, y is 0 (row top), 0.5 (the commit dot) or 1 (row bottom).
function layout(commits) {
  const lanes = []; // hash each lane is waiting for, or null when free
  const laneColor = [];
  let nextColor = 0;
  let width = 0;

  const freeLane = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  const rows = commits.map(c => {
    const before = lanes.slice();
    const colorBefore = laneColor.slice();
    const segments = [];

    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      // branch tip nobody pointed at yet
      col = freeLane();
      lanes[col] = c.hash;
      laneColor[col] = nextColor++;
    }
    const color = laneColor[col];

    // lines arriving from above: into the dot, or straight through
    before.forEach((h, j) => {
      if (h == null) return;
      if (h === c.hash) segments.push({ x1: j, y1: 0, x2: col, y2: 0.5, color: colorBefore[j] });
      else segments.push({ x1: j, y1: 0, x2: j, y2: 1, color: colorBefore[j] });
    });
    // every lane that waited for this commit ends here
    lanes.forEach((h, j) => { if (h === c.hash) lanes[j] = null; });

    c.parents.forEach((p, i) => {
      const existing = lanes.indexOf(p);
      if (i === 0 && existing > col && lanes[col] == null) {
        // keep the first-parent line in the left-most lane; the other lane still meets it at p
        lanes[col] = p;
        segments.push({ x1: col, y1: 0.5, x2: col, y2: 1, color });
        return;
      }
      if (existing !== -1) {
        // parent already has a lane (a merge back into an open branch)
        segments.push({ x1: col, y1: 0.5, x2: existing, y2: 1, color: i === 0 ? color : laneColor[existing] });
        return;
      }
      const lane = i === 0 && lanes[col] == null ? col : freeLane();
      lanes[lane] = p;
      if (lane !== col) laneColor[lane] = nextColor++;
      segments.push({ x1: col, y1: 0.5, x2: lane, y2: 1, color: i === 0 ? color : laneColor[lane] });
    });

    while (lanes.length && lanes[lanes.length - 1] == null) {
      lanes.pop();
      laneColor.pop();
    }
    width = Math.max(width, before.length, lanes.length, col + 1);
    return { col, color, segments };
  });

  return { rows, width };
}

module.exports = { layout };
