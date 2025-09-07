// Minimal project management backed by localStorage.
// A project encapsulates the positions and groups data (what we already persist)
// under namespaced keys, plus a small meta record (id, name, timestamps).

export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

const LS_PROJECTS_INDEX = "mtgcanvas_projects_index_v1" as const;
const LS_CURRENT_PROJECT = "mtgcanvas_current_project_v1" as const;
const PREFIX = "mtgcanvas_proj_v1::" as const;

export function projectPositionsKey(id: string): string {
  return `${PREFIX}${id}::positions`;
}
export function projectGroupsKey(id: string): string {
  return `${PREFIX}${id}::groups`;
}
export function projectMetaKey(id: string): string {
  return `${PREFIX}${id}::meta`;
}

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(LS_PROJECTS_INDEX);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter((s) => typeof s === "string");
    return [];
  } catch {
    return [];
  }
}
function writeIndex(ids: string[]) {
  try {
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      uniq.push(id);
    }
    localStorage.setItem(LS_PROJECTS_INDEX, JSON.stringify(uniq));
  } catch {
    /* ignore */
  }
}

function readMeta(id: string): ProjectMeta | null {
  try {
    const raw = localStorage.getItem(projectMetaKey(id));
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (!m || typeof m !== "object") return null;
    return {
      id,
      name: typeof m.name === "string" && m.name ? m.name : "Untitled Project",
      createdAt: Number(m.createdAt) || Date.now(),
      updatedAt: Number(m.updatedAt) || Date.now(),
    };
  } catch {
    return null;
  }
}

function writeMeta(meta: ProjectMeta) {
  try {
    const save = {
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
    localStorage.setItem(projectMetaKey(meta.id), JSON.stringify(save));
  } catch {
    /* ignore */
  }
}

export function listProjects(): ProjectMeta[] {
  const ids = readIndex();
  const metas: ProjectMeta[] = [];
  for (const id of ids) {
    const m = readMeta(id);
    if (m) metas.push(m);
  }
  // Sort by updatedAt desc, then createdAt desc
  metas.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  return metas;
}

function genId(): string {
  // 8-char base36 timestamp+rand for stability
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1e8).toString(36);
  return (t + r).slice(0, 12);
}

export function getCurrentProjectId(): string | null {
  try {
    const id = localStorage.getItem(LS_CURRENT_PROJECT);
    return id && typeof id === "string" && id.length ? id : null;
  } catch {
    return null;
  }
}

export function setCurrentProjectId(id: string) {
  try {
    localStorage.setItem(LS_CURRENT_PROJECT, id);
    // Ensure index contains this id
    const ids = readIndex();
    if (!ids.includes(id)) {
      ids.unshift(id);
      writeIndex(ids);
    }
  } catch {
    /* ignore */
  }
}

export function ensureInitialProject(): ProjectMeta {
  let id = getCurrentProjectId();
  if (id) {
    const m = readMeta(id);
    if (m) return m;
  }
  // Create a new default project
  id = genId();
  const now = Date.now();
  const meta: ProjectMeta = {
    id,
    name: "Untitled Project",
    createdAt: now,
    updatedAt: now,
  };
  writeMeta(meta);
  setCurrentProjectId(id);
  // Seed index
  const ids = readIndex();
  if (!ids.includes(id)) {
    ids.unshift(id);
    writeIndex(ids);
  }
  return meta;
}

export function getCurrentProjectMeta(): ProjectMeta {
  const m = ensureInitialProject();
  return m;
}

export function updateProjectName(id: string, name: string) {
  const meta = readMeta(id) || {
    id,
    name: "Untitled Project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  meta.name = (name || "Untitled Project").trim() || "Untitled Project";
  meta.updatedAt = Date.now();
  writeMeta(meta);
  // Ensure index has id
  const ids = readIndex();
  if (!ids.includes(id)) {
    ids.unshift(id);
    writeIndex(ids);
  }
}

export function touchProjectUpdated(id: string) {
  const meta = readMeta(id);
  if (!meta) return;
  meta.updatedAt = Date.now();
  writeMeta(meta);
  // Bubble id to front of index
  const ids = readIndex();
  if (!ids.includes(id)) {
    ids.unshift(id);
  } else {
    const arr = ids.filter((x) => x !== id);
    arr.unshift(id);
    writeIndex(arr);
    return;
  }
  writeIndex(ids);
}

export function getProjectKeysFor(id: string): {
  positionsKey: string;
  groupsKey: string;
} {
  return {
    positionsKey: projectPositionsKey(id),
    groupsKey: projectGroupsKey(id),
  };
}

// Create a new project (optionally named) and make it current. Returns its metadata.
export function createProject(name?: string): ProjectMeta {
  const id = genId();
  const now = Date.now();
  const meta: ProjectMeta = {
    id,
    name: (name || "Untitled Project").trim() || "Untitled Project",
    createdAt: now,
    updatedAt: now,
  };
  writeMeta(meta);
  // Add to index at front and set current
  const ids = readIndex();
  if (!ids.includes(id)) {
    ids.unshift(id);
    writeIndex(ids);
  }
  setCurrentProjectId(id);
  return meta;
}

// Duplicate an existing project: copies positions and groups payloads and creates a new meta.
export function duplicateProject(
  sourceId: string,
  newName?: string,
): ProjectMeta | null {
  try {
    const srcMeta = readMeta(sourceId);
    if (!srcMeta) return null;
    const srcPosKey = projectPositionsKey(sourceId);
    const srcGrpKey = projectGroupsKey(sourceId);
    const pos = localStorage.getItem(srcPosKey);
    const grp = localStorage.getItem(srcGrpKey);
    const meta = createProject(
      (newName || `Copy of ${srcMeta.name}`).trim() ||
        `Copy of ${srcMeta.name}`,
    );
    const dstPosKey = projectPositionsKey(meta.id);
    const dstGrpKey = projectGroupsKey(meta.id);
    if (pos != null) localStorage.setItem(dstPosKey, pos);
    if (grp != null) localStorage.setItem(dstGrpKey, grp);
    touchProjectUpdated(meta.id);
    return meta;
  } catch {
    return null;
  }
}

// Delete a project by id. Removes from index and clears stored payloads/meta.
// If deleting the current project, switches to the most-recent remaining project or creates a new one.
export function deleteProject(id: string): {
  nextProjectId: string;
  createdNew: boolean;
} {
  // Remove storage entries
  try {
    localStorage.removeItem(projectPositionsKey(id));
  } catch {}
  try {
    localStorage.removeItem(projectGroupsKey(id));
  } catch {}
  try {
    localStorage.removeItem(projectMetaKey(id));
  } catch {}
  // Update index
  let ids = readIndex().filter((x) => x !== id);
  writeIndex(ids);
  // Handle current project switch if needed
  const cur = getCurrentProjectId();
  if (cur === id) {
    // Choose next most recent or create a new one
    let nextId: string;
    let createdNew = false;
    if (ids.length) {
      nextId = ids[0];
    } else {
      const meta = ensureInitialProject();
      nextId = meta.id;
      createdNew = true;
      // ensure in index front
      ids = [nextId];
      writeIndex(ids);
    }
    setCurrentProjectId(nextId);
    return { nextProjectId: nextId, createdNew };
  }
  return {
    nextProjectId: getCurrentProjectId() || ensureInitialProject().id,
    createdNew: false,
  };
}
