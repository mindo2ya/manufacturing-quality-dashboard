import { Controller, Get } from '@nestjs/common';
import { getStorageLabel, getStorageMode } from './storage-mode';

@Controller('api/operations')
export class OperationsController {
  @Get()
  getOperations(): { storage: 'mock' | 'live'; label: string } {
    return { storage: getStorageMode(), label: getStorageLabel() };
  }
}