/**
 * Agent tab group management.
 *
 * Creates and manages a Chrome tab group labeled "Accio Agent"
 * to visually organize agent-controlled tabs.
 *
 * All addTab calls are serialized via a promise queue to prevent
 * concurrent calls from each creating separate tab groups.
 *
 * On reconnect, the manager attempts to find and reuse an existing
 * "Accio Agent" group rather than creating a duplicate.
 *
 * dissolve() clears every tab group whose title matches Accio Agent (not only one),
 * so duplicate groups from edge cases are all removed on shutdown.
 */

import { createLogger } from '../../logger.js'

const log = createLogger('group')

export const TAB_GROUP_TITLE = 'Accio Agent'
const TAB_GROUP_COLOR = 'blue'

/**
 * Match groups whose title is exactly TAB_GROUP_TITLE or ends with it
 * (e.g. "⠋ Accio Agent" while spinner is running).
 */
function isAgentGroup(group) {
  return group.title === TAB_GROUP_TITLE || group.title?.endsWith(` ${TAB_GROUP_TITLE}`)
}

async function findAllAgentGroups() {
  const all = await chrome.tabGroups.query({})
  return all.filter(isAgentGroup)
}

async function findAgentGroup() {
  const groups = await findAllAgentGroups()
  return groups.length > 0 ? groups[0] : null
}

export class AgentGroupManager {
  /** @type {number|null} */
  #groupId = null
  /** @type {Promise<void>} serialization queue */
  #queue = Promise.resolve()

  get groupId() { return this.#groupId }

  reset() { this.#groupId = null }

  async addTab(tabId) {
    const done = this.#queue.then(() => this.#doAddTab(tabId))
    this.#queue = done.catch(() => {})
    return done
  }

  async #doAddTab(tabId) {
    try {
      if (this.#groupId !== null) {
        try {
          await chrome.tabGroups.get(this.#groupId)
        } catch {
          this.#groupId = null
        }
      }

      if (this.#groupId === null) {
        await this.#tryRecoverExistingGroup()
      }

      const groupId = await chrome.tabs.group({
        tabIds: [tabId],
        ...(this.#groupId !== null ? { groupId: this.#groupId } : {}),
      })

      if (this.#groupId === null || this.#groupId !== groupId) {
        this.#groupId = groupId
        await chrome.tabGroups.update(groupId, {
          title: TAB_GROUP_TITLE,
          color: TAB_GROUP_COLOR,
          collapsed: false,
        })
      }
    } catch (err) {
      log.warn('addTab: failed for tab', tabId, err)
    }
  }

  async #tryRecoverExistingGroup() {
    try {
      const group = await findAgentGroup()
      if (group) {
        this.#groupId = group.id
        log.info('recovered existing group:', this.#groupId)
      }
    } catch {
      // chrome.tabGroups.query not available or no match
    }
  }

  /**
   * Dissolve the tab group: close agent-created tabs, ungroup the rest.
   *
   * @param {Set<number>} [agentTabIds] — tab IDs created by the agent.
   *   These will be closed (chrome.tabs.remove). Tabs NOT in this set
   *   are assumed to be user-owned and will only be ungrouped.
   *   If omitted, all tabs in the group are ungrouped without closing.
   *
   * Finds every matching "Accio Agent" tab group (plus stale cached #groupId if valid).
   * Falls back to title query because clearAll() may have reset #groupId to null first.
   */
  async dissolve(agentTabIds) {
    const cachedGid = this.#groupId
    this.#groupId = null
    log.info('dissolve: start, cached groupId =', cachedGid, 'agentTabIds count =', agentTabIds?.size ?? 0)

    /** @type {number[]} */
    let groupIds = []
    try {
      const named = await findAllAgentGroups()
      groupIds = named.map((g) => g.id)
    } catch (err) {
      log.warn('dissolve: tabGroups query failed:', err)
    }
    if (cachedGid != null && !groupIds.includes(cachedGid)) {
      try {
        await chrome.tabGroups.get(cachedGid)
        groupIds.push(cachedGid)
      } catch {
        // stale id
      }
    }
    const uniqueGroupIds = [...new Set(groupIds)]

    if (uniqueGroupIds.length === 0) {
      log.info('dissolve: no Accio Agent tab group found, skipping')
      return
    }

    log.info('dissolve: processing', uniqueGroupIds.length, 'tab group(s)')

    for (const gid of uniqueGroupIds) {
      try {
        const tabs = await chrome.tabs.query({ groupId: gid })
        log.info('dissolve: group', gid, 'has', tabs.length, 'tabs')
        if (tabs.length === 0) {
          log.info('dissolved group:', gid, '(already empty)')
          continue
        }

        const allIds = tabs.map((t) => t.id).filter((id) => id != null)
        const toClose = agentTabIds
          ? allIds.filter((id) => agentTabIds.has(id))
          : []
        const toUngroup = agentTabIds
          ? allIds.filter((id) => !agentTabIds.has(id))
          : allIds

        if (toClose.length > 0) {
          await chrome.tabs.remove(toClose)
          log.info('dissolve: closed', toClose.length, 'agent tabs in group', gid)
        }
        if (toUngroup.length > 0) {
          await chrome.tabs.ungroup(toUngroup)
          log.info('dissolve: ungrouped', toUngroup.length, 'tabs in group', gid)
        }
        log.info('dissolved group:', gid, 'closed', toClose.length, 'ungrouped', toUngroup.length)
      } catch (err) {
        log.warn('dissolve: failed for group', gid, err)
      }
    }
  }

  /**
   * Close every tab in every Chrome tab group whose title matches Accio Agent.
   * Removes the groups indirectly (empty groups disappear). Does not touch tabs outside those groups.
   * Intended for a gateway HTTP hook — stronger than dissolve(): no ungroup-only path.
   */
  async closeAllAccioAgentGroupTabs() {
    this.#groupId = null
    /** @type {number[]} */
    let groupIds = []
    try {
      const named = await findAllAgentGroups()
      groupIds = named.map((g) => g.id)
    } catch (err) {
      log.warn('closeAllAccioAgentGroupTabs: tabGroups query failed:', err)
    }
    const uniqueGroupIds = [...new Set(groupIds)]
    let closed = 0
    for (const gid of uniqueGroupIds) {
      try {
        const tabs = await chrome.tabs.query({ groupId: gid })
        const ids = tabs.map((t) => t.id).filter((id) => id != null)
        if (ids.length === 0) continue
        await chrome.tabs.remove(ids)
        closed += ids.length
      } catch (err) {
        log.warn('closeAllAccioAgentGroupTabs: failed for group', gid, err)
      }
    }
    log.info('closeAllAccioAgentGroupTabs: groups=', uniqueGroupIds.length, 'tabsClosed=', closed)
    return { success: true, groups: uniqueGroupIds.length, closed }
  }
}
