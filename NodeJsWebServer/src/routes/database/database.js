const { Router } = require('express');
const {
  listObjects,
  createObject,
  updateObject,
  deleteObject,
  listReadings,
  listValueKeys,
  createValueKey,
  deleteValueKey,
  updateValueKey,
  listTopicCommands,
  updateTopicCommands,
  listTopics
} = require('../../controllers/objectsController.js');

const router = Router();

router.get('/', listObjects);
router.post('/', createObject);
router.put('/:id', updateObject);
router.delete('/:id', deleteObject);
router.get('/:id/readings', listReadings);
router.get('/:id/keys', listValueKeys);
router.post('/:id/keys', createValueKey);
router.put('/:id/keys/:keyId', updateValueKey);
router.delete('/:id/keys/:keyId', deleteValueKey);
router.get('/:id/commands', listTopicCommands);
router.put('/:id/commands', updateTopicCommands);
router.get('/:id/topics', listTopics);

module.exports = router;
