const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── identity (swap these before submitting) ──────────────────────────────────
const IDENT = {
  user_id: "johndoe_17091999",
  email_id: "john.doe@srm.edu.in",
  college_roll_number: "RA2211003010001",
};

// ── validation ───────────────────────────────────────────────────────────────
const EDGE_RE = /^([A-Z])->([A-Z])$/;

function parseRawEntry(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  const hit = trimmed.match(EDGE_RE);
  if (!hit) return null;
  const [, src, dst] = hit;
  if (src === dst) return null; // self-loop
  return { src, dst, original: trimmed };
}

// ── graph builder ─────────────────────────────────────────────────────────────
function buildAdjacency(validEdges) {
  // childOf[node] = first-encountered parent  (multi-parent: first wins)
  const childOf = {};
  const childrenOf = {};
  const allNodes = new Set();

  for (const { src, dst } of validEdges) {
    allNodes.add(src);
    allNodes.add(dst);
    if (childOf[dst] === undefined) {
      childOf[dst] = src;
      if (!childrenOf[src]) childrenOf[src] = [];
      childrenOf[src].push(dst);
    }
    // else: second parent → silently drop
  }
  return { childOf, childrenOf, allNodes };
}

// ── component finder (union-find) ─────────────────────────────────────────────
function findComponents(allNodes, childrenOf) {
  const parent = {};
  for (const n of allNodes) parent[n] = n;

  function root(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function unite(a, b) {
    const ra = root(a), rb = root(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (const [p, kids] of Object.entries(childrenOf)) {
    for (const k of kids) unite(p, k);
  }

  const groups = {};
  for (const n of allNodes) {
    const r = root(n);
    if (!groups[r]) groups[r] = [];
    groups[r].push(n);
  }
  return Object.values(groups);
}

// ── cycle detection (DFS) ─────────────────────────────────────────────────────
function hasCycleInGroup(nodes, childrenOf) {
  const visited = new Set();
  const onStack = new Set();

  function dfs(node) {
    visited.add(node);
    onStack.add(node);
    for (const child of (childrenOf[node] || [])) {
      if (!visited.has(child)) {
        if (dfs(child)) return true;
      } else if (onStack.has(child)) {
        return true;
      }
    }
    onStack.delete(node);
    return false;
  }

  for (const n of nodes) {
    if (!visited.has(n) && dfs(n)) return true;
  }
  return false;
}

// ── tree builder (nested object) ──────────────────────────────────────────────
function buildNestedTree(node, childrenOf, visited = new Set()) {
  if (visited.has(node)) return {};
  visited.add(node);
  const subtree = {};
  for (const child of (childrenOf[node] || [])) {
    subtree[child] = buildNestedTree(child, childrenOf, visited);
  }
  return subtree;
}

// ── depth calculator ──────────────────────────────────────────────────────────
function calcDepth(node, childrenOf, memo = {}) {
  if (node in memo) return memo[node];
  const kids = childrenOf[node] || [];
  if (kids.length === 0) { memo[node] = 1; return 1; }
  const deepest = Math.max(...kids.map(k => calcDepth(k, childrenOf, memo)));
  memo[node] = 1 + deepest;
  return memo[node];
}

// ── main handler ──────────────────────────────────────────────────────────────
app.post("/bfhl", (req, res) => {
  const rawList = Array.isArray(req.body?.data) ? req.body.data : [];

  const invalidEntries = [];
  const duplicateEdges = [];
  const seenEdges = new Set();
  const validEdges = [];

  for (const item of rawList) {
    const parsed = parseRawEntry(item);
    if (!parsed) {
      const label = typeof item === "string" ? item.trim() : String(item);
      if (label !== "") invalidEntries.push(label);
      else invalidEntries.push("");
      continue;
    }
    const key = parsed.original;
    if (seenEdges.has(key)) {
      if (!duplicateEdges.includes(key)) duplicateEdges.push(key);
    } else {
      seenEdges.add(key);
      validEdges.push(parsed);
    }
  }

  const { childOf, childrenOf, allNodes } = buildAdjacency(validEdges);
  const components = findComponents(allNodes, childrenOf);

  const hierarchies = [];
  let totalCycles = 0;
  let totalTrees = 0;
  let largestRoot = null;
  let largestDepth = -1;

  for (const group of components) {
    const isCyclic = hasCycleInGroup(group, childrenOf);

    // find roots (nodes not appearing as child)
    const roots = group.filter(n => childOf[n] === undefined);
    let groupRoot;
    if (roots.length === 0) {
      // pure cycle — use lex smallest
      groupRoot = [...group].sort()[0];
    } else {
      groupRoot = roots.sort()[0]; // lex smallest root if multiple
    }

    if (isCyclic) {
      totalCycles++;
      hierarchies.push({ root: groupRoot, tree: {}, has_cycle: true });
    } else {
      totalTrees++;
      const nested = {};
      nested[groupRoot] = buildNestedTree(groupRoot, childrenOf);
      const depth = calcDepth(groupRoot, childrenOf);

      hierarchies.push({ root: groupRoot, tree: nested, depth });

      if (
        depth > largestDepth ||
        (depth === largestDepth && (largestRoot === null || groupRoot < largestRoot))
      ) {
        largestDepth = depth;
        largestRoot = groupRoot;
      }
    }
  }

  // sort hierarchies for determinism (roots alphabetically)
  hierarchies.sort((a, b) => a.root.localeCompare(b.root));

  res.json({
    ...IDENT,
    hierarchies,
    invalid_entries: invalidEntries,
    duplicate_edges: duplicateEdges,
    summary: {
      total_trees: totalTrees,
      total_cycles: totalCycles,
      largest_tree_root: largestRoot ?? "",
    },
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`BFHL API running on port ${PORT}`));
