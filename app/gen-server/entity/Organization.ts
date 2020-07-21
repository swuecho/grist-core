import {Column, Entity, JoinColumn, ManyToOne, OneToMany, OneToOne,
        PrimaryGeneratedColumn, RelationId} from "typeorm";
import {Role} from "app/common/roles";
import {OrganizationProperties, organizationPropertyKeys} from "app/common/UserAPI";
import {AclRuleOrg} from "./AclRule";
import {BillingAccount} from "./BillingAccount";
import {Resource} from "./Resource";
import {User} from "./User";
import {Workspace} from "./Workspace";

// Information about how an organization may be accessed.
export interface AccessOption {
  id: number;     // a user id
  email: string;  // a user email
  name: string;   // a user name
  perms: number;  // permissions the user would have on organization
}

export interface AccessOptionWithRole extends AccessOption {
  access: Role;   // summary of permissions
}

@Entity({name: 'orgs'})
export class Organization extends Resource {

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({
    nullable: true
  })
  public domain: string;

  @OneToOne(type => User, user => user.personalOrg)
  @JoinColumn({name: 'owner_id'})
  public owner: User;

  @RelationId((org: Organization) => org.owner)
  public ownerId: number;

  @OneToMany(type => Workspace, workspace => workspace.org)
  public workspaces: Workspace[];

  @OneToMany(type => AclRuleOrg, aclRule => aclRule.organization)
  public aclRules: AclRuleOrg[];

  @Column({name: 'billing_account_id'})
  public billingAccountId: number;

  @ManyToOne(type => BillingAccount)
  @JoinColumn({name: 'billing_account_id'})
  public billingAccount: BillingAccount;

  // Property that may be returned when the org is fetched to indicate the access the
  // fetching user has on the org, i.e. 'owners', 'editors', 'viewers'
  public access: string;

  // Property that may be used internally to track multiple ways an org can be accessed
  public accessOptions?: AccessOptionWithRole[];

  // a computed column with permissions.
  // {insert: false} makes sure typeorm doesn't try to put values into such
  // a column when creating organizations.
  @Column({name: 'permissions', type: 'text', select: false, insert: false})
  public permissions?: any;

  // For custom domains, this is the preferred host associated with this org/team.
  @Column({name: 'host', type: 'text', nullable: true})
  public host: string|null;

  public checkProperties(props: any): props is Partial<OrganizationProperties> {
    return super.checkProperties(props, organizationPropertyKeys);
  }

  public updateFromProperties(props: Partial<OrganizationProperties>) {
    super.updateFromProperties(props);
    if (props.domain) { this.domain = props.domain; }
  }
}
