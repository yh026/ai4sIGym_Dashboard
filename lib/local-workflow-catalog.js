'use strict';

// These are page locations, not a list of required skills. Associations come
// from the project's public method-skill index; an omitted/empty list adds no UI.
const placements = {
  pca: { target: 'card-pca', insertion: 'before-plot' },
  tsne: { target: 'card-tsne', insertion: 'before-plot' },
  umap: { target: 'card-umap', insertion: 'before-plot' },
  kmeans: { target: 'anaFilters', insertion: 'after' },
  evaluate: { target: 'map-and-curve-body', insertion: 'append' },
};
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function methodBindings(index) {
  if (!index || index.schema_version !== 1 || !Array.isArray(index.skills)) throw new Error('Invalid method skill index.');
  const definitions = new Map();
  for (const skill of index.skills) {
    if (!skill || typeof skill.id !== 'string' || !slug.test(skill.id) || typeof skill.title !== 'string' || !skill.title.trim()
        || skill.path !== skill.id + '/SKILL.md' || definitions.has(skill.id)) {
      throw new Error('Invalid or duplicate method skill: ' + skill?.id);
    }
    definitions.set(skill.id, skill);
  }
  // Support the earlier one-step-per-entry index while new packages can declare
  // zero, one or several method skills per page node explicitly.
  let associations = index.step_skills;
  if (associations === undefined) {
    associations = {};
    for (const skill of index.skills) {
      if (!Object.hasOwn(placements, skill.workflow_step_id)) throw new Error('Unknown method step: ' + skill.workflow_step_id);
      (associations[skill.workflow_step_id] ||= []).push(skill.id);
    }
  }
  if (!associations || Array.isArray(associations) || typeof associations !== 'object') {
    throw new Error('Method step_skills must map nodes to arrays.');
  }
  const bindings = [], selected = new Set();
  for (const [step, ids] of Object.entries(associations)) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new Error('Invalid method association: ' + step);
    if (!ids.length) continue;
    if (!Object.hasOwn(placements, step)) throw new Error('Unknown method step: ' + step);
    for (const id of ids) {
      if (!definitions.has(id)) throw new Error('Unknown method skill: ' + id);
      selected.add(id);
    }
    bindings.push({ step, ...placements[step], skillIds: ids });
  }
  return { skills: index.skills.filter(skill => selected.has(skill.id)), bindings };
}

// The complete workflow is optional and independent of per-method associations.
function workflowSkill(index) {
  const skill = index.workflow_skill;
  if (skill === undefined || skill === null) return null;
  if (typeof skill.id !== 'string' || !slug.test(skill.id) || typeof skill.title !== 'string' || !skill.title.trim()
      || skill.path !== skill.id + '/SKILL.md' || index.skills.some(method => method.id === skill.id)) {
    throw new Error('Invalid or duplicate workflow skill: ' + skill?.id);
  }
  return skill;
}

module.exports = { methodBindings, workflowSkill };
