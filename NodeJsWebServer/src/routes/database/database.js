const { Router } = require('express');
const {
  listObjects,
  createObject,
  updateObject,
  deleteObject,
  listReadings,
  deleteReadings,
  databaseStatus,
  optimizeDatabaseFile,
  listValueKeys,
  createValueKey,
  deleteValueKey,
  updateValueKey,
  listTopicCommands,
  updateTopicCommands,
  listTopics,
  listAutomationRules,
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  testAutomationRule
} = require('../../controllers/objectsController.js');

const router = Router();

router.get('/', listObjects);
router.post('/', createObject);
router.get('/maintenance/database', databaseStatus);
router.post('/maintenance/database/optimize', optimizeDatabaseFile);
router.put('/:id', updateObject);
router.delete('/:id', deleteObject);
router.get('/:id/readings', listReadings);
router.delete('/:id/readings', deleteReadings);
router.get('/:id/keys', listValueKeys);
router.post('/:id/keys', createValueKey);
router.put('/:id/keys/:keyId', updateValueKey);
router.delete('/:id/keys/:keyId', deleteValueKey);
router.get('/:id/commands', listTopicCommands);
router.put('/:id/commands', updateTopicCommands);
router.get('/:id/topics', listTopics);
router.get('/:id/automations', listAutomationRules);
router.post('/:id/automations', createAutomationRule);
router.put('/:id/automations/:ruleId', updateAutomationRule);
router.delete('/:id/automations/:ruleId', deleteAutomationRule);
router.post('/:id/automations/:ruleId/test', testAutomationRule);

module.exports = router;
