// ONE @CommandHandler, delegation only (PR27) — the CommandBus is the
// binding CQRS shape (CLAUDE.md, feature 16); every constructor parameter
// carries an explicit @Inject(TOKEN) (CLAUDE.md § Explicit DI tokens).
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ProjectionApplyService } from '../projection-apply.service';
import type { ApplyOutcome } from '../ports/read-model-writer.port';
import { ProjectFactCommand } from './project-fact.command';

@Injectable()
@CommandHandler(ProjectFactCommand)
export class ProjectFactCommandHandler implements ICommandHandler<ProjectFactCommand, ApplyOutcome> {
  constructor(@Inject(ProjectionApplyService) private readonly applyService: ProjectionApplyService) {}

  execute(command: ProjectFactCommand): Promise<ApplyOutcome> {
    return this.applyService.apply(command.envelope);
  }
}
