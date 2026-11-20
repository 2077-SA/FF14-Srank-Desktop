'use strict';

/**
 * Keep only the data needed by anonymous S-rank syncing.
 * The complete syncSession response may contain A/B/B+/FATE and spawn-point datasets;
 * none of those are retained in this S-only bridge.
 */
function filterSRankResources(resources) {
  if (!resources || typeof resources !== 'object' || !resources.DatabaseHunt || !resources.DataCenters) {
    throw new Error('syncSession 缺少 DatabaseHunt 或 DataCenters。');
  }
  const DatabaseHunt = Object.fromEntries(
    Object.entries(resources.DatabaseHunt).filter(([, definition]) => Number(definition?.Rank) === 5)
  );
  if (!Object.keys(DatabaseHunt).length) throw new Error('syncSession 中没有 Rank=5 的 S 怪词条。');
  return { DatabaseHunt, DataCenters: resources.DataCenters };
}

module.exports = { filterSRankResources };
