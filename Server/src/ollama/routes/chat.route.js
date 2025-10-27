import express from 'express';
import SLMController from '../controllers/chat.controller.js';

const router = express.Router();

router.post('/generate', SLMController.generate);

export default router;