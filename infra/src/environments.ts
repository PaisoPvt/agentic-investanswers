// The AWS environments the stack is deployed to (M2-01): one AWS account each,
// signed in through the organisation's access portal with a profile per account
// (owner input OI-20). Staging and prod are added once their account numbers
// are known; nothing else changes.

export interface AiaEnvironment {
  /** Stack and resource name prefix: `aia-<name>`. */
  readonly name: 'dev' | 'staging' | 'prod';
  readonly account: string;
  readonly region: string;
  /** Two availability zones, named so the template is built without asking AWS. */
  readonly zones: readonly [string, string];
  /** The AWS CLI profile that signs in to this account, for the deploy scripts. */
  readonly profile: string;
  /**
   * NAT gateways. With none (dev), the tasks run in public subnets with a
   * public IP and accept connections only from the load balancer; with one or
   * more they run in private subnets.
   */
  readonly natGateways: number;
  /** Platform tasks behind the load balancer. */
  readonly platformTasks: number;
}

export const ENVIRONMENTS: Readonly<Record<string, AiaEnvironment>> = {
  dev: { name: 'dev', account: '448554876487', region: 'us-east-1', zones: ['us-east-1a', 'us-east-1b'], profile: 'aia-dev', natGateways: 0, platformTasks: 1 },
};
