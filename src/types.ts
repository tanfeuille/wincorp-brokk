/**
 * Types partagés WinCorp — source unique entre wincorp-thor et wincorp-bifrost.
 *
 * Regroupe :
 * - Types domaine comptable (ProfilDossier, FournisseurYAML, CompteFrequent, RegleDossier)
 * - Types Fulll (PurchaseFormInput, LigneForm, FactureSuivante)
 * - Types pipeline v2 Image (ExtractionVision, DecisionDecideur, ResultatBuilder, ContextDecideur)
 *
 * Hérité de wincorp-thor/scripts/types.ts + scripts/fulll-api.ts + scripts/v2/types-v2.ts.
 */

// ── Domaine comptable ────────────────────────────────────────────────

/** Fournisseur spécifique ou catégorie dans le profil YAML. */
export interface FournisseurYAML {
  nom_fulll: string;
  mots_cles: string[];
  compte_defaut: string;
  /** Uniquement pour les catégories (rétro-compat full-achat). */
  categorie?: string;
  alerte?: string;
  /** ID Relay Fulll — résolu par harvest-relay-ids ou Supabase. */
  relay_id?: string;
}

/** Mapping fournisseurs du profil YAML. */
export interface FournisseursYAML {
  defaut: string;
  specifiques?: FournisseurYAML[];
  categories?: FournisseurYAML[];
  administratifs?: FournisseurYAML[];
}

export interface CompteFrequent {
  compte: string;
  libelle: string;
  nature: string[];
  frequence: string;
}

export interface RegleDossier {
  regle: string;
  description: string;
  action: string;
  /** Scope de la règle — si absent, s'applique à tous les modules. */
  module?: "general" | "achats" | "image";
}

/** Profil dossier chargé depuis YAML ou Supabase. */
export interface ProfilDossier {
  identite: {
    raison_sociale: string;
    siren: string;
    forme_juridique: string;
    dirigeant: string;
    activite: string;
    code_ape: string;
  };
  comptabilite: {
    regime_tva: string;
    cloture: string;
    logiciel: string;
    company_id?: string;
    /** Book relay ID réel (base64 de "Book:{id}") — payload mutation. */
    book_relay_id?: string;
    /** Nom du journal achats (défaut: "AC - ACHATS"). */
    journal_achats?: string;
  };
  comptes_frequents: {
    charges: CompteFrequent[];
    produits: CompteFrequent[];
  };
  regles: RegleDossier[];
  fournisseurs?: FournisseursYAML;
  guide_ventilation?: string;
  parametres?: {
    seuil_confiance?: number;
    seuil_confiance_achats?: number;
    seuil_confiance_image?: number;
    limite_docs_session?: number;
    thinking_budget?: number;
    mode_audit?: boolean;
    telecharger_pdf?: boolean;
    mode_agent?: string;
    comptes_digits?: 6 | 8;
  };
  /** IDs Relay des fournisseurs — fallback quand bookQuery provider.id est vide. */
  fournisseurs_relay_ids?: Record<string, string>;
  /** IDs Relay des comptes — fallback quand compte absent de bookQuery. */
  comptes_relay_ids?: Record<string, string>;
}

// ── Types Fulll (GraphQL) ────────────────────────────────────────────

export interface LigneForm {
  /** ID Relay (GeneralAccount:...). */
  accountId: string;
  /** PCG 8 chiffres (ex: 62560000). */
  accountNumber: string | null;
  accountName: string | null;
  label: string | null;
  debit: number | null;
  credit: number | null;
}

export interface FactureSuivante {
  totalCount: number;
  documentId: string;
  documentURL: string;
  /** ID Relay du Book (journal) — auto-découvert depuis data.book.id. */
  bookRelayId: string;
  provider: {
    id: string;
    name: string;
    /** Préfixe fournisseur (ex: FRESTO, FDIVERS). */
    accountNumber: string;
  };
  form: {
    date: string | null;
    reference: string | null;
    header: {
      label: string | null;
      credit: number | null;
      debit: number | null;
    };
    body: LigneForm[];
    accountDetails: {
      companyRegistration: string | null;
      intraVAT: string | null;
      phone: string | null;
      fax: string | null;
    };
    /** Période d'exercice ouverte côté Fulll (ERR-DATE-01). */
    period: {
      start: string | null;
      end: string | null;
    } | null;
  };
  _raw?: unknown;
}

/** Payload pour recordPurchaseFormMutation — calqué sur le HAR capturé. */
export interface PurchaseFormInput {
  book: string;
  document: string;
  date: string;
  currency?: string | null;
  period?: string | null;
  provider: string;
  dueDate?: string | null;
  balance?: unknown | null;
  payment?: unknown | null;
  total?: unknown | null;
  accountDetails?: {
    companyRegistration: string | null;
    intraVAT: string | null;
    phone: string | null;
    fax: string | null;
  };
  header: {
    reference: string;
    label: string;
    debit: number | null;
    credit: number;
    analytic?: unknown | null;
    vat?: unknown | null;
  };
  body: {
    /** ID Relay du compte. */
    account: string;
    label: string;
    debit: number | null;
    credit: number | null;
    vat?: unknown | null;
    quantity?: number | null;
    analytic?: unknown | null;
  }[];
  footer: unknown[];
}

// ── Pipeline v2 Image ────────────────────────────────────────────────

/** Sortie de l'extracteur Vision — aucun champ comptable. */
export interface ExtractionVision {
  emetteur: {
    nom: string;
    siren?: string;
    vat?: string;
    pays?: string;
  };
  numero_piece: string;
  date: string;
  montant_ht_total?: number;
  montant_ttc_total: number;
  lignes_tva: Array<{
    taux: number;
    base_ht: number;
    montant_tva: number;
  }>;
  lignes: ExtractionLigne[];
  indices_context: IndicesContext;
  confiance_extraction: number;
  meta: {
    modele_utilise: "haiku" | "sonnet" | "skipped";
    inversion_date_appliquee: boolean;
    tokens_input: number;
    tokens_output: number;
    skipped_reason?: "releve_bancaire" | "hors_exercice";
  };
}

export interface ExtractionLigne {
  libelle: string;
  quantite?: number;
  montant_ht?: number;
  taux_tva?: number;
  montant_ttc?: number;
}

/** Signaux visuels discriminants. */
export interface IndicesContext {
  nb_couverts?: number;
  mention_invites?: boolean;
  type_transaction?: "b2b" | "b2c" | "inconnu";
  items_top?: string[];
  carburant?: { type: "diesel" | "essence" | "gpl" | null; litres?: number };
  vehicule_immat?: string;
  est_ticket_caisse?: boolean;
  est_avoir?: boolean;
  mention_acompte?: boolean;
}

export interface DecisionDecideur {
  compte_charge: string;
  regime_tva: "FR" | "intracom" | "extracom" | "franchise";
  fournisseur_fulll: string;
  libelle_ecriture: string;
  raisonnement: string;
  confiance: number;
  alertes: string[];
}

export interface ResultatBuilder {
  decision: "comptabiliser" | "douteux" | "erreur";
  payload?: PurchaseFormInput;
  raison?: string;
  confiance: number;
  comptesFinaux: string[];
}

export interface ContextDecideur {
  profil: ProfilDossier;
  planComptableCharges: CompteFrequent[];
  fournisseurs: {
    specifiques: FournisseurYAML[];
    categories: FournisseurYAML[];
    administratifs: FournisseurYAML[];
    defaut: string;
  };
  guideVentilation?: string;
  reglesMetier: RegleDossier[];
  contexteFulll: {
    providerName: string;
    providerAccountNumber: string;
    comptesPrerempliesBody: Array<{
      accountNumber: string | null;
      debit: number | null;
      credit: number | null;
      label: string | null;
    }>;
    period: { start: string | null; end: string | null } | null;
  } | null;
  seuilConfiance?: number;
}
