// The CDK app (M2-01): one stack per AWS environment, `aia-<name>`.
//
//   pnpm synth                      every environment's template, no AWS access needed
//   pnpm deploy:dev                 deploy to the dev account (scripts/aws.mjs)

import { App } from 'aws-cdk-lib';

import { AiaStack } from './aia-stack.js';
import { ENVIRONMENTS } from './environments.js';

const app = new App();
for (const environment of Object.values(ENVIRONMENTS)) {
  new AiaStack(app, `aia-${environment.name}`, {
    environment,
    env: { account: environment.account, region: environment.region },
    description: `InvestAnswers agentic platform, ${environment.name} (M2-01)`,
    tags: { project: 'agentic-investanswers', environment: environment.name },
  });
}
app.synth();
