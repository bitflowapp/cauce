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
      business_riders: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          id: string
          name: string
          phone: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          id?: string
          name: string
          phone?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          id?: string
          name?: string
          phone?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_riders_business_id_fkey"
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
      drivers: {
        Row: {
          available: boolean
          created_at: string
          display_name: string
          id: string
          locality_id: string
          mobile_number: string
          phone: string
          plate: string
          review_note: string
          status: string
          updated_at: string
          user_id: string
          vehicle: string
        }
        Insert: {
          available?: boolean
          created_at?: string
          display_name: string
          id?: string
          locality_id: string
          mobile_number?: string
          phone?: string
          plate?: string
          review_note?: string
          status?: string
          updated_at?: string
          user_id: string
          vehicle?: string
        }
        Update: {
          available?: boolean
          created_at?: string
          display_name?: string
          id?: string
          locality_id?: string
          mobile_number?: string
          phone?: string
          plate?: string
          review_note?: string
          status?: string
          updated_at?: string
          user_id?: string
          vehicle?: string
        }
        Relationships: [
          {
            foreignKeyName: "drivers_locality_id_fkey"
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
      order_events: {
        Row: {
          actor_id: string | null
          actor_role: string
          business_id: string
          created_at: string
          customer_id: string
          from_status: string | null
          id: string
          note: string
          order_id: string
          to_status: string
        }
        Insert: {
          actor_id?: string | null
          actor_role: string
          business_id: string
          created_at?: string
          customer_id: string
          from_status?: string | null
          id?: string
          note?: string
          order_id: string
          to_status: string
        }
        Update: {
          actor_id?: string | null
          actor_role?: string
          business_id?: string
          created_at?: string
          customer_id?: string
          from_status?: string | null
          id?: string
          note?: string
          order_id?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_events_business_scope"
            columns: ["order_id", "business_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "order_events_customer_scope"
            columns: ["order_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "customer_id"]
          },
        ]
      }
      order_items: {
        Row: {
          business_id: string
          customer_id: string
          dish_type: string
          id: string
          image_path: string | null
          order_id: string
          position: number
          product_id: string | null
          product_name: string
          quantity: number
          total_ars: number
          unit_price_ars: number
          variant_id: string | null
          variant_name: string
        }
        Insert: {
          business_id: string
          customer_id: string
          dish_type?: string
          id?: string
          image_path?: string | null
          order_id: string
          position?: number
          product_id?: string | null
          product_name: string
          quantity: number
          total_ars: number
          unit_price_ars: number
          variant_id?: string | null
          variant_name?: string
        }
        Update: {
          business_id?: string
          customer_id?: string
          dish_type?: string
          id?: string
          image_path?: string | null
          order_id?: string
          position?: number
          product_id?: string | null
          product_name?: string
          quantity?: number
          total_ars?: number
          unit_price_ars?: number
          variant_id?: string | null
          variant_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_business_scope"
            columns: ["order_id", "business_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "order_items_customer_scope"
            columns: ["order_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "customer_id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          address: string
          business_id: string
          cancel_reason: string
          code: string
          contact_name: string
          contact_phone: string
          created_at: string
          currency: string
          customer_id: string
          delivery_code: string | null
          delivery_fee_ars: number
          fulfillment: string
          id: string
          idempotency_key: string
          locality_id: string
          notes: string
          payment_method: string
          payment_status: string
          request_fingerprint: string
          rider_id: string | null
          status: string
          subtotal_ars: number
          total_ars: number
          tracking_token: string
          updated_at: string
          version: number
        }
        Insert: {
          address?: string
          business_id: string
          cancel_reason?: string
          code: string
          contact_name: string
          contact_phone: string
          created_at?: string
          currency?: string
          customer_id: string
          delivery_code?: string | null
          delivery_fee_ars?: number
          fulfillment: string
          id?: string
          idempotency_key: string
          locality_id: string
          notes?: string
          payment_method: string
          payment_status?: string
          request_fingerprint: string
          rider_id?: string | null
          status?: string
          subtotal_ars: number
          total_ars: number
          tracking_token?: string
          updated_at?: string
          version?: number
        }
        Update: {
          address?: string
          business_id?: string
          cancel_reason?: string
          code?: string
          contact_name?: string
          contact_phone?: string
          created_at?: string
          currency?: string
          customer_id?: string
          delivery_code?: string | null
          delivery_fee_ars?: number
          fulfillment?: string
          id?: string
          idempotency_key?: string
          locality_id?: string
          notes?: string
          payment_method?: string
          payment_status?: string
          request_fingerprint?: string
          rider_id?: string | null
          status?: string
          subtotal_ars?: number
          total_ars?: number
          tracking_token?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "orders_business_id_locality_id_fkey"
            columns: ["business_id", "locality_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id", "locality_id"]
          },
          {
            foreignKeyName: "orders_rider_id_business_id_fkey"
            columns: ["rider_id", "business_id"]
            isOneToOne: false
            referencedRelation: "business_riders"
            referencedColumns: ["id", "business_id"]
          },
        ]
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
      trip_events: {
        Row: {
          actor_id: string | null
          actor_role: string
          created_at: string
          from_status: string | null
          id: string
          note: string
          to_status: string
          trip_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_role: string
          created_at?: string
          from_status?: string | null
          id?: string
          note?: string
          to_status: string
          trip_id: string
        }
        Update: {
          actor_id?: string | null
          actor_role?: string
          created_at?: string
          from_status?: string | null
          id?: string
          note?: string
          to_status?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          accepted_at: string | null
          cancel_reason: string
          code: string
          created_at: string
          destination: string
          driver_id: string | null
          expires_at: string
          id: string
          locality_id: string
          origin: string
          origin_note: string
          passenger_id: string
          passenger_name: string
          passenger_phone: string
          passengers: number
          status: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          cancel_reason?: string
          code: string
          created_at?: string
          destination: string
          driver_id?: string | null
          expires_at: string
          id?: string
          locality_id: string
          origin: string
          origin_note?: string
          passenger_id: string
          passenger_name: string
          passenger_phone: string
          passengers?: number
          status?: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          cancel_reason?: string
          code?: string
          created_at?: string
          destination?: string
          driver_id?: string | null
          expires_at?: string
          id?: string
          locality_id?: string
          origin?: string
          origin_note?: string
          passenger_id?: string
          passenger_name?: string
          passenger_phone?: string
          passengers?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_locality_id_fkey"
            columns: ["locality_id"]
            isOneToOne: false
            referencedRelation: "localities"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_trip: {
        Args: { trip: string }
        Returns: {
          accepted_at: string | null
          cancel_reason: string
          code: string
          created_at: string
          destination: string
          driver_id: string | null
          expires_at: string
          id: string
          locality_id: string
          origin: string
          origin_note: string
          passenger_id: string
          passenger_name: string
          passenger_phone: string
          passengers: number
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "trips"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_drivers: {
        Args: never
        Returns: {
          available: boolean
          created_at: string
          display_name: string
          id: string
          locality_id: string
          mobile_number: string
          phone: string
          plate: string
          review_note: string
          status: string
          updated_at: string
          user_id: string
          vehicle: string
        }[]
        SetofOptions: {
          from: "*"
          to: "drivers"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      admin_snapshot: {
        Args: never
        Returns: Database["public"]["CompositeTypes"]["admin_overview"]
        SetofOptions: {
          from: "*"
          to: "admin_overview"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      apply_as_driver: {
        Args: {
          display_name: string
          mobile_number?: string
          phone?: string
          plate?: string
          vehicle?: string
        }
        Returns: {
          available: boolean
          created_at: string
          display_name: string
          id: string
          locality_id: string
          mobile_number: string
          phone: string
          plate: string
          review_note: string
          status: string
          updated_at: string
          user_id: string
          vehicle: string
        }
        SetofOptions: {
          from: "*"
          to: "drivers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
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
      create_order: {
        Args: {
          business: string
          contact: Json
          fulfillment: string
          idem: string
          items: Json
          payment_method: string
        }
        Returns: string
      }
      driver_offers: {
        Args: never
        Returns: Database["public"]["CompositeTypes"]["trip_offer"][]
        SetofOptions: {
          from: "*"
          to: "trip_offer"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      my_access: { Args: never; Returns: boolean }
      request_trip: {
        Args: {
          destination: string
          origin: string
          origin_note?: string
          passenger_name?: string
          passenger_phone?: string
          passengers?: number
        }
        Returns: {
          accepted_at: string | null
          cancel_reason: string
          code: string
          created_at: string
          destination: string
          driver_id: string | null
          expires_at: string
          id: string
          locality_id: string
          origin: string
          origin_note: string
          passenger_id: string
          passenger_name: string
          passenger_phone: string
          passengers: number
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "trips"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      review_business: {
        Args: { business: string; decision: string; note?: string }
        Returns: string
      }
      review_driver: {
        Args: { decision: string; driver: string; note?: string }
        Returns: string
      }
      set_business_presence: {
        Args: { business: string; is_open?: boolean; next_status?: string }
        Returns: string
      }
      set_driver_availability: {
        Args: { is_available: boolean }
        Returns: {
          available: boolean
          created_at: string
          display_name: string
          id: string
          locality_id: string
          mobile_number: string
          phone: string
          plate: string
          review_note: string
          status: string
          updated_at: string
          user_id: string
          vehicle: string
        }
        SetofOptions: {
          from: "*"
          to: "drivers"
          isOneToOne: true
          isSetofReturn: false
        }
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
      transition_order: {
        Args: {
          expected_version?: number
          next_status?: string
          order_id: string
          reason?: string
          rider?: string
        }
        Returns: {
          address: string
          business_id: string
          cancel_reason: string
          code: string
          contact_name: string
          contact_phone: string
          created_at: string
          currency: string
          customer_id: string
          delivery_code: string | null
          delivery_fee_ars: number
          fulfillment: string
          id: string
          idempotency_key: string
          locality_id: string
          notes: string
          payment_method: string
          payment_status: string
          request_fingerprint: string
          rider_id: string | null
          status: string
          subtotal_ars: number
          total_ars: number
          tracking_token: string
          updated_at: string
          version: number
        }
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      transition_trip: {
        Args: { next_status: string; reason?: string; trip: string }
        Returns: {
          accepted_at: string | null
          cancel_reason: string
          code: string
          created_at: string
          destination: string
          driver_id: string | null
          expires_at: string
          id: string
          locality_id: string
          origin: string
          origin_note: string
          passenger_id: string
          passenger_name: string
          passenger_phone: string
          passengers: number
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "trips"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      trip_driver: {
        Args: { trip: string }
        Returns: Database["public"]["CompositeTypes"]["assigned_driver"]
        SetofOptions: {
          from: "*"
          to: "assigned_driver"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      admin_overview: {
        generated_at: string | null
        businesses: Json | null
        drivers: Json | null
        orders: Json | null
        trips: Json | null
      }
      assigned_driver: {
        id: string | null
        display_name: string | null
        mobile_number: string | null
        vehicle: string | null
        plate: string | null
        phone: string | null
      }
      trip_offer: {
        id: string | null
        code: string | null
        status: string | null
        origin: string | null
        origin_note: string | null
        destination: string | null
        passengers: number | null
        passenger_initial: string | null
        created_at: string | null
        expires_at: string | null
      }
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
