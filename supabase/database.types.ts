export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      business_categories: {
        Row: {
          active: boolean
          id: string
          name: string
          position: number
          slug: string
        }
        Insert: {
          active?: boolean
          id?: string
          name: string
          position?: number
          slug: string
        }
        Update: {
          active?: boolean
          id?: string
          name?: string
          position?: number
          slug?: string
        }
        Relationships: []
      }
      business_contacts: {
        Row: {
          business_id: string
          email: string
          owner_name: string
          phone: string
          reference: string
          updated_at: string
        }
        Insert: {
          business_id: string
          email?: string
          owner_name?: string
          phone?: string
          reference?: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          email?: string
          owner_name?: string
          phone?: string
          reference?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_contacts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_memberships: {
        Row: {
          business_id: string
          created_at: string
          role: string
          user_id: string
        }
        Insert: {
          business_id: string
          created_at?: string
          role: string
          user_id: string
        }
        Update: {
          business_id?: string
          created_at?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_memberships_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_review_events: {
        Row: {
          actor_id: string | null
          actor_role: string
          business_id: string
          created_at: string
          from_status: string
          id: string
          note: string
          to_status: string
        }
        Insert: {
          actor_id?: string | null
          actor_role: string
          business_id: string
          created_at?: string
          from_status: string
          id?: string
          note?: string
          to_status: string
        }
        Update: {
          actor_id?: string | null
          actor_role?: string
          business_id?: string
          created_at?: string
          from_status?: string
          id?: string
          note?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_review_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          address: string
          category_id: string | null
          cover_path: string | null
          created_at: string
          delivery_enabled: boolean
          delivery_fee_ars: number
          delivery_zone: string
          description: string
          hours_label: string
          id: string
          locality_id: string
          logo_path: string | null
          minimum_order_ars: number
          name: string
          open: boolean
          pickup_enabled: boolean
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          address?: string
          category_id?: string | null
          cover_path?: string | null
          created_at?: string
          delivery_enabled?: boolean
          delivery_fee_ars?: number
          delivery_zone?: string
          description?: string
          hours_label?: string
          id?: string
          locality_id: string
          logo_path?: string | null
          minimum_order_ars?: number
          name: string
          open?: boolean
          pickup_enabled?: boolean
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string
          category_id?: string | null
          cover_path?: string | null
          created_at?: string
          delivery_enabled?: boolean
          delivery_fee_ars?: number
          delivery_zone?: string
          description?: string
          hours_label?: string
          id?: string
          locality_id?: string
          logo_path?: string | null
          minimum_order_ars?: number
          name?: string
          open?: boolean
          pickup_enabled?: boolean
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "businesses_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "business_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "businesses_locality_id_fkey"
            columns: ["locality_id"]
            isOneToOne: false
            referencedRelation: "localities"
            referencedColumns: ["id"]
          },
        ]
      }
      localities: {
        Row: {
          active: boolean
          id: string
          name: string
          slug: string
        }
        Insert: {
          active?: boolean
          id?: string
          name: string
          slug: string
        }
        Update: {
          active?: boolean
          id?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
      product_categories: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          id: string
          name: string
          position: number
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          id?: string
          name: string
          position?: number
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          id?: string
          name?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "product_categories_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      product_variants: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          id: string
          name: string
          position: number
          price_delta_ars: number
          product_id: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          id?: string
          name: string
          position?: number
          price_delta_ars?: number
          product_id: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          id?: string
          name?: string
          position?: number
          price_delta_ars?: number
          product_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_product_id_business_id_fkey"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      products: {
        Row: {
          archived: boolean
          available: boolean
          business_id: string
          category_id: string | null
          created_at: string
          description: string
          dish_type: string
          id: string
          image_path: string | null
          locality_id: string
          name: string
          position: number
          price_ars: number
          stock: number
          updated_at: string
        }
        Insert: {
          archived?: boolean
          available?: boolean
          business_id: string
          category_id?: string | null
          created_at?: string
          description?: string
          dish_type?: string
          id?: string
          image_path?: string | null
          locality_id: string
          name: string
          position?: number
          price_ars: number
          stock?: number
          updated_at?: string
        }
        Update: {
          archived?: boolean
          available?: boolean
          business_id?: string
          category_id?: string | null
          created_at?: string
          description?: string
          dish_type?: string
          id?: string
          image_path?: string | null
          locality_id?: string
          name?: string
          position?: number
          price_ars?: number
          stock?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_business_id_locality_id_fkey"
            columns: ["business_id", "locality_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id", "locality_id"]
          },
          {
            foreignKeyName: "products_category_id_business_id_fkey"
            columns: ["category_id", "business_id"]
            isOneToOne: false
            referencedRelation: "product_categories"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          phone: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name: string
          phone?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string
          phone?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      business_missing_requirements: {
        Args: { business: string }
        Returns: string[]
      }
      create_business: {
        Args: {
          business_name: string
          business_slug: string
          locality_slug?: string
        }
        Returns: string
      }
      my_access: { Args: never; Returns: boolean }
      review_business: {
        Args: { business: string; decision: string; note?: string }
        Returns: string
      }
      set_business_presence: {
        Args: { business: string; is_open?: boolean; next_status?: string }
        Returns: string
      }
      set_product_availability: {
        Args: { is_available: boolean; next_stock?: number; product: string }
        Returns: {
          archived: boolean
          available: boolean
          business_id: string
          category_id: string | null
          created_at: string
          description: string
          dish_type: string
          id: string
          image_path: string | null
          locality_id: string
          name: string
          position: number
          price_ars: number
          stock: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "products"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      submit_business_for_review: {
        Args: { business: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
