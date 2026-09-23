// Hand-written to match the simplified 17-table schema (see
// ../../../../scratchpad/schema.sql for the SQL that created it — not part
// of this repo, run directly against Supabase). Regenerate/verify with
// `supabase gen types typescript` once the project is linked, but this file
// is the source of truth until then. Both frontends' data access goes
// through this backend, so neither keeps its own copy of these types.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type UserRole = "customer" | "admin" | "agent";
export type ProfileStatus = "active" | "suspended" | "inactive";
export type RequestPriority = "low" | "medium" | "high" | "urgent";
export type MessageSenderType = "customer" | "admin" | "agent" | "assistant" | "system";
export type AiSenderType = "customer" | "assistant" | "system";
export type KnowledgeStatus = "draft" | "published" | "archived";
export type RunStatus = "running" | "awaiting_approval" | "completed" | "failed";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type AgentProviderStatus = "active" | "disabled";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          first_name: string;
          last_name: string | null;
          email: string | null;
          phone: string | null;
          role: UserRole;
          status: ProfileStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          first_name: string;
          last_name?: string | null;
          email?: string | null;
          phone?: string | null;
          role?: UserRole;
          status?: ProfileStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
      customer_profiles: {
        Row: {
          user_id: string;
          organization_name: string | null;
          city: string | null;
          country: string;
          preferred_language: string;
        };
        Insert: {
          user_id: string;
          organization_name?: string | null;
          city?: string | null;
          country?: string;
          preferred_language?: string;
        };
        Update: Partial<Database["public"]["Tables"]["customer_profiles"]["Insert"]>;
        Relationships: [];
      };
      admin_profiles: {
        Row: {
          user_id: string;
          department: string | null;
          permissions: Json;
        };
        Insert: {
          user_id: string;
          department?: string | null;
          permissions?: Json;
        };
        Update: Partial<Database["public"]["Tables"]["admin_profiles"]["Insert"]>;
        Relationships: [];
      };
      request_categories: {
        Row: {
          id: string;
          name: string;
          description: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["request_categories"]["Insert"]>;
        Relationships: [];
      };
      request_statuses: {
        Row: {
          id: string;
          name: string;
          sequence: number;
          is_final: boolean;
        };
        Insert: {
          id?: string;
          name: string;
          sequence: number;
          is_final?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["request_statuses"]["Insert"]>;
        Relationships: [];
      };
      requests: {
        Row: {
          id: string;
          customer_id: string;
          category_id: string | null;
          status_id: string | null;
          assigned_agent_id: string | null;
          title: string;
          description: string;
          priority: RequestPriority;
          source: string;
          created_at: string;
          updated_at: string;
          resolved_at: string | null;
        };
        Insert: {
          id?: string;
          customer_id: string;
          category_id?: string | null;
          status_id?: string | null;
          assigned_agent_id?: string | null;
          title: string;
          description: string;
          priority?: RequestPriority;
          source?: string;
          created_at?: string;
          updated_at?: string;
          resolved_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["requests"]["Insert"]>;
        Relationships: [];
      };
      request_messages: {
        Row: {
          id: string;
          request_id: string;
          sender_id: string | null;
          sender_type: MessageSenderType;
          message: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          request_id: string;
          sender_id?: string | null;
          sender_type: MessageSenderType;
          message: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["request_messages"]["Insert"]>;
        Relationships: [];
      };
      request_status_history: {
        Row: {
          id: string;
          request_id: string;
          old_status_id: string | null;
          new_status_id: string | null;
          changed_by: string | null;
          reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          request_id: string;
          old_status_id?: string | null;
          new_status_id?: string | null;
          changed_by?: string | null;
          reason?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["request_status_history"]["Insert"]>;
        Relationships: [];
      };
      ai_conversations: {
        Row: {
          id: string;
          customer_id: string;
          title: string | null;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          customer_id: string;
          title?: string | null;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["ai_conversations"]["Insert"]>;
        Relationships: [];
      };
      ai_messages: {
        Row: {
          id: string;
          conversation_id: string;
          sender_type: AiSenderType;
          content: string;
          model: string | null;
          /** See migrations/0009_ai_messages_feedback.sql. */
          feedback: "up" | "down" | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          sender_type: AiSenderType;
          content: string;
          model?: string | null;
          feedback?: "up" | "down" | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["ai_messages"]["Insert"]>;
        Relationships: [];
      };
      knowledge_categories: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["knowledge_categories"]["Insert"]>;
        Relationships: [];
      };
      knowledge_documents: {
        Row: {
          id: string;
          title: string;
          content: string | null;
          file_url: string | null;
          file_type: string | null;
          status: KnowledgeStatus;
          category_id: string | null;
          uploaded_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          content?: string | null;
          file_url?: string | null;
          file_type?: string | null;
          status?: KnowledgeStatus;
          category_id?: string | null;
          uploaded_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["knowledge_documents"]["Insert"]>;
        Relationships: [];
      };
      knowledge_chunks: {
        Row: {
          id: string;
          document_id: string;
          content: string;
          chunk_index: number;
          embedding: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          content: string;
          chunk_index: number;
          embedding?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["knowledge_chunks"]["Insert"]>;
        Relationships: [];
      };
      customer_memory: {
        Row: {
          id: string;
          customer_id: string;
          memory_key: string;
          memory_value: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          customer_id: string;
          memory_key: string;
          memory_value: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["customer_memory"]["Insert"]>;
        Relationships: [];
      };
      agent_tools: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          requires_approval: boolean;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string | null;
          requires_approval?: boolean;
          is_active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["agent_tools"]["Insert"]>;
        Relationships: [];
      };
      agent_runs: {
        Row: {
          id: string;
          customer_id: string | null;
          conversation_id: string | null;
          request_id: string | null;
          status: RunStatus;
          iterations: number;
          current_step: string | null;
          tool_name: string | null;
          tool_input: Json | null;
          tool_output: Json | null;
          model: string | null;
          prompt_version: string | null;
          started_at: string;
          completed_at: string | null;
          error_message: string | null;
        };
        Insert: {
          id?: string;
          customer_id?: string | null;
          conversation_id?: string | null;
          request_id?: string | null;
          status?: RunStatus;
          iterations?: number;
          current_step?: string | null;
          tool_name?: string | null;
          tool_input?: Json | null;
          tool_output?: Json | null;
          model?: string | null;
          prompt_version?: string | null;
          started_at?: string;
          completed_at?: string | null;
          error_message?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["agent_runs"]["Insert"]>;
        Relationships: [];
      };
      agent_approvals: {
        Row: {
          id: string;
          agent_run_id: string;
          requested_action: string;
          reason: string | null;
          status: ApprovalStatus;
          requested_at: string;
          reviewed_by: string | null;
          reviewed_at: string | null;
          review_comment: string | null;
        };
        Insert: {
          id?: string;
          agent_run_id: string;
          requested_action: string;
          reason?: string | null;
          status?: ApprovalStatus;
          requested_at?: string;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          review_comment?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["agent_approvals"]["Insert"]>;
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          request_id: string | null;
          title: string;
          message: string;
          is_read: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          request_id?: string | null;
          title: string;
          message: string;
          is_read?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["notifications"]["Insert"]>;
        Relationships: [];
      };
      boundary_rules: {
        Row: {
          id: string;
          category: string;
          pattern: string;
          fallback_message: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          category: string;
          pattern: string;
          fallback_message: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["boundary_rules"]["Insert"]>;
        Relationships: [];
      };
      clarification_triggers: {
        Row: {
          id: string;
          pattern: string | null;
          question: string;
          is_fallback: boolean;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          pattern?: string | null;
          question: string;
          is_fallback?: boolean;
          is_active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["clarification_triggers"]["Insert"]>;
        Relationships: [];
      };
      agent_providers: {
        Row: {
          id: string;
          name: string;
          provider: string;
          model: string | null;
          api_key: string;
          status: AgentProviderStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          provider: string;
          model?: string | null;
          api_key: string;
          status?: AgentProviderStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["agent_providers"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      user_role: UserRole;
      profile_status: ProfileStatus;
      request_priority: RequestPriority;
      message_sender_type: MessageSenderType;
      ai_sender_type: AiSenderType;
      knowledge_status: KnowledgeStatus;
      approval_status: ApprovalStatus;
      agent_provider_status: AgentProviderStatus;
    };
  };
}

// Convenience row aliases used throughout src/
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type CustomerProfile = Database["public"]["Tables"]["customer_profiles"]["Row"];
export type AdminProfile = Database["public"]["Tables"]["admin_profiles"]["Row"];
export type RequestCategory = Database["public"]["Tables"]["request_categories"]["Row"];
export type RequestStatusRow = Database["public"]["Tables"]["request_statuses"]["Row"];
export type RequestRow = Database["public"]["Tables"]["requests"]["Row"];
export type RequestMessageRow = Database["public"]["Tables"]["request_messages"]["Row"];
export type RequestStatusHistoryRow = Database["public"]["Tables"]["request_status_history"]["Row"];
export type AiConversationRow = Database["public"]["Tables"]["ai_conversations"]["Row"];
export type AiMessageRow = Database["public"]["Tables"]["ai_messages"]["Row"];
export type KnowledgeCategoryRow = Database["public"]["Tables"]["knowledge_categories"]["Row"];
export type KnowledgeDocumentRow = Database["public"]["Tables"]["knowledge_documents"]["Row"];
export type KnowledgeChunkRow = Database["public"]["Tables"]["knowledge_chunks"]["Row"];
export type CustomerMemoryRow = Database["public"]["Tables"]["customer_memory"]["Row"];
export type AgentToolRow = Database["public"]["Tables"]["agent_tools"]["Row"];
export type AgentRunRow = Database["public"]["Tables"]["agent_runs"]["Row"];
export type AgentApprovalRow = Database["public"]["Tables"]["agent_approvals"]["Row"];
export type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];
export type AgentProviderRow = Database["public"]["Tables"]["agent_providers"]["Row"];
export type BoundaryRuleRow = Database["public"]["Tables"]["boundary_rules"]["Row"];
export type ClarificationTriggerRow = Database["public"]["Tables"]["clarification_triggers"]["Row"];
