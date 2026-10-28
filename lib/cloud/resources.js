'use strict';

// Picks which resource to read for each classifier in an account entry. An
// entry can list the same classifier twice (plain names, and names starting
// "Smart Meter, "), and an account can have a dead entry that returns 401 for
// everything. Resources are identified by classifier, never resourceTypeId:
// the type IDs of the two gas copies don't match the API document.

/** The time in a /last-time response, in ms, or null. */
function lastTimeOf(body) {
  const seconds = body && body.data && body.data.lastTs;
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** Resource IDs with a classifier, in the order the entry lists them. */
function copiesOf(resources, classifier) {
  return resources.filter((resource) => resource.classifier === classifier).map((resource) => resource.resourceId);
}

/**
 * Chooses one resource for each classifier. `lastTimes` maps resource ID to its
 * /last-time in ms, or null where that call failed; `stored` maps classifier
 * to the resource ID chosen before. The latest /last-time wins. On a tie, or
 * when no copy answered, the stored copy is kept, otherwise the first listed.
 * Returns { classifier: { resourceId, lastTime } }.
 */
function selectResources(resources, lastTimes, stored = {}) {
  const selected = {};
  for (const classifier of new Set(resources.map((resource) => resource.classifier))) {
    const copies = copiesOf(resources, classifier);
    const latest = Math.max(...copies.map((id) => lastTimes.get(id) ?? -Infinity));
    const best = copies.filter((id) => (lastTimes.get(id) ?? -Infinity) === latest);
    const resourceId = best.includes(stored[classifier]) ? stored[classifier] : best[0];
    selected[classifier] = { resourceId, lastTime: lastTimes.get(resourceId) ?? null };
  }
  return selected;
}

/**
 * The resource for live power and the import register on an existing device:
 * its stored resource if that's still an electricity.consumption resource,
 * since it's working for that user; otherwise the first one listed. Older
 * pairings chose by name and could fall back to another classifier.
 */
function liveElectricityResource(resources, storedId) {
  const stored = resources.find((resource) => resource.resourceId === storedId);
  if (stored && stored.classifier === 'electricity.consumption') return storedId;
  return copiesOf(resources, 'electricity.consumption')[0] || null;
}

/** True for an entry where every call made on its resources returned 401. */
function isDeadEntry(statuses) {
  return statuses.length > 0 && statuses.every((status) => status === 401);
}

module.exports = {
  lastTimeOf, copiesOf, selectResources, liveElectricityResource, isDeadEntry,
};
