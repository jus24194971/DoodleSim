// B.A.T.M.A.N. Advanced route selection, modelled on the real thing.
//
// Until now a "link" here meant a line somebody drew between two nodes, and the mesh
// was only a label. Real batman-adv does not work that way: every radio that can hear
// another is a potential neighbour, and the routing layer picks the relay chain for
// you. This module reproduces that choice so the map can show where traffic will
// actually go rather than where the operator happened to draw a line.
//
// HOW BATMAN-ADV ACTUALLY ROUTES
//
// It is a layer-2, proactive, distance-vector protocol. Each node periodically
// broadcasts an Originator Message; neighbours rebroadcast it. A node therefore
// learns "I can reach originator X, and the best neighbour to hand it to is Y" - it
// knows only the NEXT HOP, never the whole path. The path this module computes is
// the emergent result of every node making that local choice, which is the same
// thing traffic experiences.
//
// Two metrics ship in batman-adv and both are selectable in OpenWrt via
// routing_algo, so both are here:
//
//   BATMAN_IV - transmit quality. Each link carries TQ 0-255, derived from what
//     fraction of OGMs survive the round trip, so it already folds in asymmetry.
//     Forwarding multiplies: TQ_path = TQ_a * TQ_b / 255. Reliability compounds, so
//     it prefers short, solid chains and punishes a marginal hop hard.
//
//   BATMAN_V - throughput. Each link is rated in units of 100 kbit/s and a path is
//     worth its BOTTLENECK, not the product. It will take an extra hop if that
//     avoids a slow link, which IV would not.
//
// Both apply a hop penalty per forwarding node - default 30 of 255, so about 12% per
// hop - which is what stops a mesh from stringing together endless relays.
//
// WHAT IS GROUNDED AND WHAT IS ESTIMATED
//
// The protocol mechanics above, TQ_MAX of 255 and the default hop penalty of 30 are
// batman-adv's own. Link throughput comes from DoodleSim's existing link budget, so
// it is as good as the rest of the tool. The one estimate is pdrFromMargin() below -
// turning a dB margin into a packet delivery ratio - and it is isolated here so it
// can be corrected from link status logs rather than guessed at again elsewhere.

export const TQ_MAX = 255;
export const DEFAULT_HOP_PENALTY = 30;      // batman-adv default, out of TQ_MAX

export const ROUTING_ALGOS = [
  { id: 'iv', label: 'BATMAN_IV (transmit quality)',
    note: 'Reliability compounds along the path. Prefers short, solid chains.' },
  { id: 'v', label: 'BATMAN_V (throughput)',
    note: 'A path is worth its slowest hop. Will take an extra hop to avoid a slow link.' },
];

/**
 * Packet delivery ratio implied by how far a link sits above the rate it is using.
 *
 * ESTIMATE. Real TQ is measured from OGM survival, which cannot be known in advance.
 * The curve is centred so a link exactly at its sensitivity requirement delivers
 * about half its packets, and one 8 dB clear delivers essentially all of them, which
 * matches the shape of the sensitivity tables.
 */
export function pdrFromMargin(marginDb) {
  if (!Number.isFinite(marginDb)) return 0;
  return 1 / (1 + Math.exp(-(marginDb - 2) / 1.6));
}

/** Link TQ 0-255 from the margin the link budget produced. */
export function tqFromMargin(marginDb) {
  return Math.max(0, Math.min(TQ_MAX, Math.round(TQ_MAX * pdrFromMargin(marginDb))));
}

/** The factor one forwarding hop costs, under either algorithm. */
export function hopFactor(hopPenalty = DEFAULT_HOP_PENALTY) {
  return (TQ_MAX - Math.max(0, Math.min(TQ_MAX, hopPenalty))) / TQ_MAX;
}

/**
 * Extend a path metric across one more hop.
 *
 * IV multiplies quality and normalises back into 0-255; V keeps the bottleneck. The
 * hop penalty applies either way, which is the part people forget when they assume a
 * mesh will relay indefinitely for free.
 */
export function extendMetric(algo, soFar, linkMetric, hopPenalty = DEFAULT_HOP_PENALTY) {
  if (soFar == null) return linkMetric;             // first hop is not yet a forward
  const f = hopFactor(hopPenalty);
  return algo === 'v'
    ? Math.min(soFar, linkMetric) * f
    : (soFar * linkMetric / TQ_MAX) * f;
}

/**
 * Build the neighbour graph.
 *
 * `pairs` is every node pair that was evaluated, each carrying its link result. A
 * pair only becomes an edge if it closes: a link that cannot carry MCS0 is not a
 * neighbour, however close the two radios look on the map.
 */
export function buildGraph(nodeIds, pairs, { algo = 'iv' } = {}) {
  const adj = new Map(nodeIds.map((id) => [id, []]));
  const edges = [];
  for (const p of pairs) {
    if (!p.usable) continue;
    const metric = algo === 'v' ? p.mbps : tqFromMargin(p.marginDb);
    if (!(metric > 0)) continue;
    const e = { a: p.a, b: p.b, metric, mbps: p.mbps, marginDb: p.marginDb,
                tq: tqFromMargin(p.marginDb), distM: p.distM };
    edges.push(e);
    adj.get(p.a)?.push({ to: p.b, ...e });
    adj.get(p.b)?.push({ to: p.a, ...e });
  }
  return { adj, edges, algo };
}

/**
 * Best route from one origin to every node it can reach.
 *
 * Dijkstra with a max-priority frontier. Valid for both metrics because a hop can
 * only make a path worse - the hop penalty is below 1 and both extend rules are
 * monotonically non-increasing - so once a node is settled nothing can improve it.
 */
export function bestRoutesFrom(graph, originId, { hopPenalty = DEFAULT_HOP_PENALTY } = {}) {
  const best = new Map([[originId, {
    metric: Infinity, hops: 0, path: [originId], via: null, bottleneckMbps: Infinity,
  }]]);
  const settled = new Set();
  for (;;) {
    let cur = null;
    for (const [id, r] of best) {
      if (settled.has(id)) continue;
      if (cur == null || r.metric > best.get(cur).metric) cur = id;
    }
    if (cur == null) break;
    settled.add(cur);
    const curR = best.get(cur);
    for (const e of graph.adj.get(cur) || []) {
      if (settled.has(e.to)) continue;
      const m = extendMetric(graph.algo,
                             curR.metric === Infinity ? null : curR.metric,
                             e.metric, hopPenalty);
      const prev = best.get(e.to);
      if (!prev || m > prev.metric) {
        best.set(e.to, {
          metric: m,
          hops: curR.hops + 1,
          path: [...curR.path, e.to],
          // batman-adv knows only the next hop. This is the neighbour the origin
          // hands the frame to, which is the thing an operator can actually verify
          // against the radio's own originator table.
          via: curR.path.length === 1 ? e.to : curR.via,
          bottleneckMbps: Math.min(curR.bottleneckMbps, e.mbps),
          lastHop: cur,
        });
      }
    }
  }
  best.delete(originId);
  return best;
}

/** Every node's routing table, the way each would build its own. */
export function routeMesh(graph, nodeIds, opts = {}) {
  const tables = new Map();
  for (const id of nodeIds) tables.set(id, bestRoutesFrom(graph, id, opts));
  return tables;
}

/**
 * Which edges actually carry traffic, and which are merely radio-visible.
 *
 * A mesh usually has far more audible pairs than it has routes in use. Marking the
 * difference is the point of the exercise: it is what tells you a relay is
 * load-bearing rather than decorative.
 */
export function activeEdges(tables) {
  const used = new Set();
  for (const [, table] of tables) {
    for (const [, r] of table) {
      for (let i = 0; i < r.path.length - 1; i++) {
        const x = r.path[i], y = r.path[i + 1];
        used.add(x < y ? `${x}-${y}` : `${y}-${x}`);
      }
    }
  }
  return used;
}

/**
 * Nodes whose loss would orphan somebody.
 *
 * The question a customer actually asks about a mesh is "what happens when I lose
 * one?", and the honest answer is usually that one or two relays are carrying the
 * whole thing.
 */
export function criticalRelays(graph, nodeIds, opts = {}) {
  if (nodeIds.length < 3) return [];
  const out = [];
  for (const id of nodeIds) {
    const alive = nodeIds.filter((n) => n !== id);
    const sub = {
      ...graph,
      adj: new Map(alive.map((n) => [n, (graph.adj.get(n) || []).filter((e) => e.to !== id)])),
    };
    const reached = bestRoutesFrom(sub, alive[0], opts).size + 1;
    if (reached < alive.length) out.push(id);
  }
  return out;
}
