import type { TenantInfo, TenantSettings } from '../api';

export interface TenantCounts {
  members: number; students: number; teachers: number; admins: number; publishedCourses: number;
  awaitingReview: number; enrollments: number; completions: number; certificates: number;
}
export interface TenantRow {
  id: string; slug: string; name: string; displayName: string; status: 'active' | 'suspended';
  createdAt: string; updatedAt: string; counts?: TenantCounts; lastActivity: string | null;
}
export interface TenantDetail {
  tenant: TenantRow; settings: TenantSettings; public: TenantInfo;
  admins: { id: string; name: string; email: string; memberCode: string; isRoot: boolean; isActive: boolean; activated: boolean; createdAt: string }[];
  activity: { id: number; created_at: string; actor_email: string | null; actor_role: string | null; action: string; target_type: string | null }[];
}
