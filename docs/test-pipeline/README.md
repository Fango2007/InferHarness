# Benchmark execution model — InferHarness

Status: durable test-pipeline specification.

Supporting files:

- Example benchmark documents are stored in [`examples/`](./examples/).
- Canonical benchmark JSON Schema specifications are stored in
  [`../schemas/benchmark/`](../schemas/benchmark/). The application runtime must
  keep using the backend source copies under `backend/src/schemas/benchmark/`.

## Product goals alignment

Le système doit être conçu pour répondre aux objectifs produit suivants :

```text
- reproductibilité des benchmarks
- comparaison équitable entre modèles
- architecture provider-neutral
- exécution local-first
- préservation de la confidentialité
- auditabilité complète des runs
- rejeu déterministe des benchmarks
- support des évaluations quantitatives et qualitatives
- extensibilité multi-provider
- indépendance vis-à-vis du langage d’implémentation
```

## Principe architectural fondamental

Le modèle conceptuel du benchmark doit rester indépendant du langage.

Un langage d'implémentation concret est considéré comme :

```text
- une implémentation possible du moteur
- un runtime d'exécution optionnel
- un adaptateur possible pour des tests existants ou spécialisés
```

mais pas comme :

```text
- le modèle produit lui-même
- le contrat d’architecture
- une dépendance obligatoire du pipeline de benchmark
```

Le cœur du système repose sur des objets JSON versionnés et validés par schéma.

Conséquence importante :

```text
Le pipeline de benchmark doit pouvoir exécuter ses tests déclaratifs sans
dépendre d'un runner Python.
```

Python peut rester supporté comme runtime optionnel lorsque le test exige du
code arbitraire, une librairie spécialisée, ou une compatibilité avec des tests
historiques. Cette compatibilité ne doit pas empêcher le modèle canonique de
représenter les mêmes comportements sous forme de `TestTemplate` déclaratif.

## Schéma-driven architecture

InferHarness doit être considéré comme un système :

```text
schema-driven
```

Les schémas JSON deviennent les contrats officiels du système.

Tous les composants doivent être construits autour de ces contrats :

```text
- validation
- persistence
- orchestration
- API future
- UI future
- distributed execution futur
- compatibility/versioning
```

## Persistence des documents benchmark

Les documents benchmark canoniques ne doivent pas dépendre exclusivement de
SQLite. La base locale reste un index/runtime cache, mais les documents
réutilisables doivent pouvoir être reconstruits depuis des fichiers JSON.

Le système doit distinguer deux bibliothèques :

```text
- bibliothèque built-in : fichiers JSON versionnés avec l'application
- bibliothèque utilisateur : fichiers JSON locaux, ignorés par Git par défaut
```

Règles attendues :

```text
- au démarrage, importer les documents built-in puis les documents utilisateur
- valider chaque document avec son schéma benchmark avant import
- utiliser l'identifiant naturel du document comme clé (kind, id)
- les documents utilisateur gagnent sur les documents built-in de même clé
- une création ou modification via l'API doit écrire le JSON utilisateur puis la DB
- une suppression de document built-in doit créer une tombstone utilisateur
- une suppression de document utilisateur doit supprimer le fichier et l'entrée DB
- la DB doit pouvoir être reconstruite depuis les fichiers si elle est effacée
```

Cette règle s'applique à `test_template`, `dataset_manifest`,
`runtime_profile` et `benchmark_plan`. Elle évite que les templates créés ou
édités dans l'application soient perdus dès qu'une base SQLite locale est
supprimée ou qu'un nouveau worktree est créé.

## Schémas normatifs recommandés

Le système doit définir explicitement les schémas suivants :

```text
schemas/
    test_template.schema.json
    model_profile.schema.json
    model_snapshot.schema.json
    runtime_profile.schema.json
    dataset_manifest.schema.json
    test_instantiation.schema.json
    test_run_result.schema.json
    benchmark_plan.schema.json
```

Chaque schéma doit inclure :

```text
schema_version
required fields
type constraints
enum constraints
compatibility rules
```

## Politique local-first et sécurité

Le système doit privilégier une approche local-first.

Principes recommandés :

```text
- datasets URL désactivés par défaut
- activation explicite requise pour les datasets distants
- secrets jamais persistés
- redaction obligatoire des données sensibles
- sandbox policy pour tout runtime d'exécution de code arbitraire
- contrôle de taille des prompts/réponses
- stratégie de compression/truncation configurable
```

## Politique de persistence des secrets

Les champs suivants ne doivent jamais être persistés en clair :

```text
Authorization
API-Key
X-API-Key
Cookie
Bearer tokens
```

## Politique de stockage des artefacts volumineux

Le système doit prévoir :

```text
- compression optionnelle
- truncation configurable
- retention policies
- external artifact storage futur
```

pour :

```text
- prompts très longs
- réponses très longues
- traces tool calling
- embeddings
- logs détaillés
```

## ModelProfile vs ModelSnapshot

Le système doit distinguer :

```text
ModelProfile
→ configuration logique ciblée

ModelSnapshot
→ état exact réellement benchmarké
```

### `ModelProfile`

Décrit la cible souhaitée avant instanciation :

```text
- model.model_id et model.server_id issus du ModelRecord applicatif
- identity.provider : fournisseur LLM/base model
- identity.quantized_provider : fournisseur du build quantifié
- endpoints.base_url et runtime.api.schema_family : serveur/runtime d'inférence
- capabilities : capacités serveur déclarées ou supposées selon `inferencer-server-schema.json`
- model_capabilities : capacités modèle déclarées ou supposées selon `model-schema.json`
```

Les capacités du `ModelProfile` sont déclaratives. Elles expriment ce que l’utilisateur, la configuration ou le catalogue modèle pense être disponible, en gardant les objets imbriqués canoniques.

Le champ `identity.provider` reprend la sémantique existante de l'application : il désigne le fournisseur LLM/base model (`mistral`, `meta`, `qwen`, etc.). Il ne doit pas être utilisé pour représenter Ollama, vLLM, LM Studio ou llama.cpp. Ces informations appartiennent au bloc `inference_server`.

### `ModelSnapshot`

Capture l’état réellement observé au moment de l’instanciation.

Il ne doit pas être un simple sac de champs optionnels. Il doit être structuré afin de rester extensible.

Structure recommandée :

```json
{
  "model": {
    "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "server_id": "ollama-local",
    "display_name": "Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "base_model_name": "Mistral-7B-Instruct-v0.3"
  },

  "identity": {
    "provider": "mistral",
    "family": "mistral",
    "version": "7B-Instruct-v0.3",
    "revision": null,
    "checksum": null,
    "quantized_provider": "lmstudio-community"
  },

  "architecture": {
    "type": "decoder-only",
    "parameter_count": null,
    "parameter_count_label": "7B",
    "active_parameter_label": null,
    "precision": "int4",
    "quantisation": {
      "method": "gguf",
      "bits": 4,
      "group_size": null,
      "scheme": "k-quant",
      "variant": "M",
      "weight_format": "Q4_K_M"
    },
    "format": "GGUF"
  },

  "model_capabilities": {
    "generation": {
      "text": true,
      "json_schema_output": true,
      "tools": false,
      "embeddings": false
    },
    "multimodal": {
      "vision": false,
      "audio": false
    },
    "reasoning": {
      "supported": false,
      "explicit_tokens": false
    }
  },

  "inference_server": {
    "server_id": "ollama-local",
    "display_name": "Local Ollama"
  },

  "runtime": {
    "retrieved_at": "2026-05-16T15:30:00Z",
    "source": "server",
    "server_software": {
      "name": "ollama",
      "version": "unknown",
      "build": null
    },
    "api": {
      "schema_family": ["ollama"],
      "api_version": null
    }
  },

  "endpoints": {
    "base_url": "http://localhost:11434",
    "health_url": null,
    "https": false
  },

  "auth": {
    "type": "none",
    "header_name": "Authorization",
    "token_env": null,
    "token": null,
    "token_present": false
  },

  "capabilities": {
    "server": {
      "streaming": true,
      "models_endpoint": true
    },
    "generation": {
      "text": true,
      "json_schema_output": true,
      "tools": false,
      "embeddings": false
    },
    "multimodal": {
      "vision": {
        "input_images": false,
        "output_images": false
      },
      "audio": {
        "input_audio": false,
        "output_audio": false
      }
    },
    "reasoning": {
      "exposed": false,
      "token_budget_configurable": false
    },
    "concurrency": {
      "parallel_requests": true,
      "parallel_tool_calls": false,
      "max_concurrent_requests": null
    },
    "enforcement": "server"
  },

  "discovery": {
    "retrieved_at": "2026-05-16T15:30:00Z",
    "ttl_seconds": 300,
    "model_list": {
      "raw": {},
      "normalised": []
    }
  },

  "model_metadata": {},

  "raw": {},

  "snapshot_quality": {
    "completeness": "partial",
    "sources": ["provider_api", "model_name_parse"],
    "warnings": []
  }
}
```

Objectif :

```text
Garantir la comparabilité et la reproductibilité des runs sans surestimer la fiabilité des métadonnées locales.
```

## Clarification des capabilities

La spécification distingue trois niveaux de capabilities.

### 1. Capabilities déclarées dans `ModelProfile`

Elles décrivent ce qui est attendu ou configuré.

Exemple :

```json
{
  "capabilities": {
    "server": {
      "streaming": true,
      "models_endpoint": true
    },
    "generation": {
      "text": true,
      "json_schema_output": true,
      "tools": false,
      "embeddings": false
    },
    "multimodal": {},
    "reasoning": {},
    "concurrency": {},
    "enforcement": "server"
  }
}
```

Elles ne constituent pas une preuve.

### 2. Capabilities canoniques observées dans `ModelSnapshot`

Elles décrivent ce qui a été observé ou inféré pendant l’instanciation.

Exemple :

```json
{
  "capabilities": {
    "server": {
      "streaming": true,
      "models_endpoint": true
    },
    "generation": {
      "text": true,
      "json_schema_output": true,
      "tools": false,
      "embeddings": false
    },
    "multimodal": {},
    "reasoning": {},
    "concurrency": {},
    "enforcement": "server"
  }
}
```

Elles doivent être utilisées pour valider si un test est réellement exécutable, sans introduire de vocabulaire de capabilities alternatif.

### 3. Capabilities nécessaires dans `TestTemplate`

Elles décrivent les prérequis fonctionnels du test.

Exemple :

```json
{
  "required_capabilities": {
    "tool_calling": true,
    "structured_output": false
  }
}
```

Le moteur doit résoudre les capabilities obligatoires vers les chemins canoniques du snapshot :

```text
tool_calling      -> ModelSnapshot.capabilities.generation.tools
structured_output -> ModelSnapshot.capabilities.generation.json_schema_output
streaming         -> ModelSnapshot.capabilities.server.streaming
```

si une capability est obligatoire.

## Résolution de `operation_spec`

`operation_spec` est résolu à partir :

```text
- model_profile.runtime.api.schema_family
- model_profile.endpoints.base_url
- model_profile.model.model_id
- template.operation
- model_snapshot.capabilities et model_snapshot.model_capabilities
```

Les chemins canoniques importants pour cette résolution sont :

```text
runtime.server_software
capabilities.generation.tools
capabilities.server.streaming
model_capabilities.generation.tools
```

Le moteur doit refuser l’instanciation si :

```text
- le template requiert tool_calling mais le snapshot ne le détecte pas
- le template requiert structured_output mais le snapshot ne le détecte pas
- l’opération logique n’est pas compatible avec le provider ou le modèle observé
```

## Qualité et niveau de preuve du ModelSnapshot

Les serveurs locaux exposent parfois peu de métadonnées fiables. Le `ModelSnapshot` doit donc indiquer la qualité des informations capturées dans `snapshot_quality`, sans mélanger les champs de preuve avec les valeurs de `architecture`.

Valeurs proposées pour `snapshot_quality.sources[]` :

```text
provider_api
server_config
model_file_metadata
model_name_parse
user_declared
heuristic
unknown
```

Un champ global résume la qualité du snapshot :

```json
{
  "snapshot_quality": {
    "completeness": "partial",
    "sources": ["provider_api", "model_name_parse"],
    "warnings": [
      "quantisation inferred from model name; not confirmed by provider API"
    ]
  }
}
```

Valeurs proposées pour `completeness` :

```text
complete
partial
minimal
unknown
```

## Clarification sur l'engine

Le fichier historique initialement nommé `common.py` ne doit plus être considéré
comme le contrat produit du benchmark.

Il décrivait des fonctions structurantes du moteur d'exécution, mais ces
fonctions doivent être portées dans une architecture indépendante du langage.

Noms conceptuels recommandés :

```text
benchmark_engine
```

ou :

```text
execution_engine
```

Dans une implémentation Python, ces noms peuvent devenir `benchmark_engine.py`
ou `execution_engine.py`. Dans l'implémentation actuelle de l'application, ils
peuvent être réalisés par des services TypeScript. Le nom de fichier n'est pas
normatif ; les responsabilités le sont.

Dans la suite de cette spécification, le terme `engine` désigne ce composant cœur.

## Architecture générale

Le système doit être séparé en deux couches :

```text
1. Core execution engine
→ exécute un TestInstantiation figé

2. Orchestration layer
→ prépare et exécute des plans multi-tests / multi-modèles
```

Le système repose sur quatre objets principaux :

```text
1. TestTemplate
→ définition réutilisable d’un type de benchmark

2. TestInstantiation
→ benchmark figé, entièrement résolu et rejouable

3. TestRunResult
→ résultat d’une exécution concrète

4. BenchmarkPlan
→ plan d’orchestration permettant d’exécuter un même template sur plusieurs modèles, datasets ou runtime profiles
```

## Principe fondamental

Le moteur d'exécution ne doit pas exécuter directement un template abstrait.

Avant exécution, le template doit être :

```text
- résolu
- enrichi
- figé
- persisté
```

sous la forme d’un objet :

```text
TestInstantiation
```

Ce snapshot devient :

```text
- l’unité persistée en base de données
- l’unité de rejeu
- l’unité d’audit
- l’unité de comparaison
```

## Pipeline cible — exécution unitaire

```text
Template + ModelProfile + Dataset + RuntimeProfile
→ instantiate_test()
→ TestInstantiation JSON figé
→ engine exécute uniquement ce JSON
→ TestRunResult
```

## Pipeline cible — orchestration multi-modèles

```text
BenchmarkPlan
→ N TestInstantiations
→ N TestRunResults
→ comparaison globale
```

Le moteur d’exécution reste centré sur une unité atomique :

```text
1 TestInstantiation
→ 1 TestRunResult
```

La comparaison multi-modèles appartient à une couche supérieure d’orchestration.

## Décision de conception importante

Le `TestInstantiation` ne doit pas uniquement contenir des références.

Il doit contenir des snapshots résolus :

```text
- snapshot du template
- manifeste vérifiable du dataset réellement utilisé
- snapshot du modèle réellement benchmarké
- operation_spec résolu
- paramètres runtime résolus
```

afin de garantir :

```text
- la rejouabilité
- l’auditabilité
- la stabilité des comparaisons
```

## DatasetManifest

Même si le dataset provient :

```text
- d’un fichier
- d’une URL
```

le contenu réellement utilisé doit être soit :

```text
- embarqué dans le TestInstantiation
- référencé via un artefact immuable adressé par hash
- représenté par un manifeste vérifiable suffisant pour détecter toute dérive
```

Sinon :

```text
- le fichier peut changer
- l’URL peut disparaître
- les résultats deviennent non reproductibles
```

Le système doit donc distinguer :

```text
source
→ origine du dataset

manifest
→ preuve vérifiable du dataset réellement exécuté

snapshot storage
→ stockage optionnel du contenu exact
```

Le `TestInstantiation` ne doit pas nécessairement embarquer tous les items du dataset.

Il doit toujours embarquer un `DatasetManifest` figé.

### Politiques de snapshot dataset

Valeurs proposées :

```text
embedded
manifest_only
compressed_blob
```

#### `embedded`

Politique adaptée aux petits datasets.

Le contenu normalisé des items peut être inclus directement dans le `DatasetManifest`.

#### `manifest_only`

Politique par défaut en v1.

Le `TestInstantiation` conserve :

```text
- source
- canonicalization_version
- dataset_hash
- item_count
- item_hashes optionnels
- item_manifest_ref optionnel
```

mais n’embarque pas nécessairement tous les items.

#### `compressed_blob`

Politique prévue par le schéma mais non implémentée en v1.

Elle permettra plus tard de stocker une version compressée et dédupliquée du dataset réellement exécuté.

Exemple :

```json
{
  "snapshot_policy": "compressed_blob",
  "snapshot_blob_ref": {
    "type": "content_addressed_blob",
    "hash": "sha256:...",
    "uri": "datasets/blobs/sha256-....jsonl.zst",
    "compression": "zstd",
    "media_type": "application/jsonl",
    "size_bytes": 123456,
    "uncompressed_size_bytes": 987654,
    "item_count": 2500
  }
}
```

### Structure recommandée du `DatasetManifest`

```json
{
  "dataset_id": "verbosity_prompts_v1",
  "source": {
    "source_type": "file",
    "format": "jsonl",
    "path": "./datasets/verbosity_prompts.jsonl"
  },
  "canonicalization_version": "dataset_canonical_v1",
  "snapshot_policy": "manifest_only",
  "dataset_hash": "sha256:...",
  "item_count": 2500,
  "item_hashes": null,
  "item_manifest_ref": {
    "type": "local_artifact",
    "hash": "sha256:...",
    "uri": "datasets/manifests/sha256-....json"
  },
  "snapshot_blob_ref": null
}
```

## Hash d’intégrité

Le design doit permettre de stocker :

```text
- hash du dataset
- hash du template
- hash du model_snapshot si pertinent
```

Exemple :

```json
{
  "dataset_hash": "sha256:...",
  "template_hash": "sha256:..."
}
```

afin de détecter toute modification ultérieure.

## Objectif

L'`engine` constitue le socle commun d'exécution des tests de benchmark. Il doit contenir les fonctions génériques utilisées par tous les templates : résolution d'opération, préparation des datasets, construction des requêtes, exécution HTTP, normalisation des réponses, calcul des métriques et agrégation.

Le principe directeur est le suivant :

```text
Template déclaratif + ModelProfile + Dataset + RuntimeParameters
→ exécution générique
→ résultats normalisés
```

Le template ne doit pas contenir d’endpoint HTTP concret. Il déclare une opération logique. L’API concrète est déduite du modèle et du provider.

---

---

# Organisation modulaire recommandée

Architecture cible conceptuelle :

```text
engine/
    execution_engine
    providers
    datasets
    payloads
    http
    responses
    metrics
    aggregation

orchestrators/
    benchmark_plan_runner
    comparison_runner
    batch_runner
```

Les extensions de fichiers (`.ts`, `.py`, etc.) relèvent de l'implémentation.
Le pipeline canonique doit rester défini par les schémas JSON et par les
responsabilités ci-dessous.

## Responsabilité du core engine

Le core engine doit gérer :

```text
- instantiate_test()
- run_test_instantiation()
- resolve_operation_spec()
- prepare_dataset()
- build_dataset_manifest()
- build_request_payload()
- execute_test_stage()
- execute_http_request()
- normalise_response()
- compute_metrics()
- aggregate_metrics()
```

## Responsabilité de la couche orchestration

La couche orchestration doit gérer :

```text
- run_benchmark_plan()
- instantiate_benchmark_plan()
- compare_test_results()
- schedule_batch()
```

Elle peut appeler le moteur plusieurs fois, mais le moteur ne doit pas connaître la notion de benchmark global multi-modèles.

---

# Fonction 0 — `instantiate_test()`

## Rôle

Construire un snapshot figé et entièrement résolu d’un benchmark prêt à être exécuté.

Cette fonction répond à la question :

```text
Quel est le benchmark exact qui sera exécuté ?
```

Elle transforme :

```text
- un template abstrait
- un profil modèle
- un dataset
- des paramètres runtime
```

vers :

```text
un TestInstantiation immuable et persistable
```

## Signature proposée

```python
def instantiate_test(
    template: dict,
    model_profile: dict,
    runtime_parameters: dict,
    dataset_spec: dict
) -> dict:
```

## Paramètres d’entrée

### `template: dict`

Template de benchmark abstrait.

Contient typiquement :

```text
- operation
- stages
- metrics
- aggregations
```

### Exemple

```json
{
  "kind": "test_template",
  "schema_version": "test_template_v1",
  "template_id": "verbosity_ratio_v1",
  "template_version": "1.0.0",

  "description": "Measure verbosity and generation efficiency across models.",

  "operation": "chat_completion",

  "stages": [
    {
      "id": "warmup",
      "type": "dataset_loop",
      "iterations_per_item": 1,
      "record_metrics": false,
      "order": "sequential"
    },
    {
      "id": "measure",
      "type": "dataset_loop",
      "iterations_per_item": 5,
      "record_metrics": true,
      "order": "sequential",
      "cooldown_ms": 100
    }
  ],

  "metrics": [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "elapsed_ms",
    "tokens_per_second",
    "output_input_token_ratio"
  ],

  "aggregations": [
    "mean",
    "median",
    "p95",
    "max"
  ],

  "required_capabilities": {
    "chat_completion": true,
    "streaming": false,
    "tool_calling": false,
    "structured_output": false
  }
}
```

### `model_profile: dict`

Profil modèle sélectionné pour l’exécution.

Exemple :

```json
{
  "model": {
    "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "server_id": "ollama-local",
    "display_name": "Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "base_model_name": "Mistral-7B-Instruct-v0.3"
  },
  "identity": {
    "provider": "mistral",
    "family": "mistral",
    "version": "7B-Instruct-v0.3",
    "revision": null,
    "checksum": null,
    "quantized_provider": "lmstudio-community"
  },
  "architecture": {
    "type": "decoder-only",
    "parameter_count": null,
    "parameter_count_label": "7B",
    "active_parameter_label": null,
    "precision": "int4",
    "quantisation": {
      "method": "gguf",
      "bits": 4,
      "group_size": null,
      "scheme": "k-quant",
      "variant": "M",
      "weight_format": "Q4_K_M"
    },
    "format": "GGUF"
  },
  "inference_server": {
    "server_id": "ollama-local",
    "display_name": "Local Ollama"
  },
  "runtime": {
    "server_software": {
      "name": "ollama",
      "version": null,
      "build": null
    },
    "api": {
      "schema_family": ["ollama"],
      "api_version": null
    }
  },
  "endpoints": {
    "base_url": "http://localhost:11434"
  },
  "capabilities": {
    "server": {
      "streaming": true,
      "models_endpoint": true
    },
    "generation": {
      "text": true,
      "json_schema_output": true,
      "tools": false,
      "embeddings": false
    },
    "multimodal": {},
    "reasoning": {},
    "concurrency": {},
    "enforcement": "server"
  },
  "discovery": {
    "retrieved_at": "2026-05-16T15:30:00Z"
  }
}
```

### `runtime_parameters: dict`

Paramètres runtime appliqués au benchmark.

Exemple :

```json
{
  "temperature": 0.2,
  "top_p": 0.9,
  "max_tokens": 512,
  "stream": false,
  "seed": 42,
  "stop": null,
  "presence_penalty": 0,
  "frequency_penalty": 0,
  "timeout_ms": 300000,
  "unsupported_parameter_policy": "strict"
}
```

### `dataset_spec: dict`

Spécification du dataset.

Exemple :

```json
{
  "source_type": "file",
  "format": "jsonl",
  "path": "./datasets/verbosity_prompts.jsonl"
}
```

## Comportement attendu

La fonction doit :

```text
1. Capturer l’état réel du modèle via capture_model_snapshot()
2. Valider template.required_capabilities contre les capabilities canoniques du snapshot
3. Résoudre l’operation_spec via resolve_operation_spec()
4. Charger et normaliser le dataset via prepare_dataset()
5. Construire le DatasetManifest via build_dataset_manifest()
6. Construire les snapshots et manifestes résolus
7. Calculer les hashes d’intégrité
8. Produire un JSON autonome et persistable
```

## Fonction support — `capture_model_snapshot()`

### Rôle

Capturer l’état réel du modèle et du serveur d’inférence au moment de l’instanciation du test.

Cette fonction répond à la question :

```text
Quel modèle, dans quel état concret, va être benchmarké ?
```

### Signature proposée

```python
def capture_model_snapshot(
    model_profile: dict
) -> dict:
```

### Entrée

`model_profile` décrit la cible logique :

```json
{
  "model": {
    "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "server_id": "ollama-local",
    "display_name": "Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "base_model_name": "Mistral-7B-Instruct-v0.3"
  },
  "identity": {
    "provider": "mistral",
    "family": "mistral",
    "version": "7B-Instruct-v0.3",
    "revision": null,
    "checksum": null,
    "quantized_provider": "lmstudio-community"
  },
  "inference_server": {
    "server_id": "ollama-local",
    "display_name": "Local Ollama"
  },
  "runtime": {
    "server_software": {
      "name": "ollama",
      "version": null,
      "build": null
    },
    "api": {
      "schema_family": ["ollama"],
      "api_version": null
    }
  },
  "endpoints": {
    "base_url": "http://localhost:11434"
  },
  "capabilities": {
    "server": {
      "streaming": true,
      "models_endpoint": true
    },
    "generation": {
      "text": true,
      "json_schema_output": true,
      "tools": false,
      "embeddings": false
    },
    "multimodal": {},
    "reasoning": {},
    "concurrency": {},
    "enforcement": "server"
  },
  "discovery": {
    "retrieved_at": "2026-05-16T15:30:00Z"
  }
}
```

### Sortie

La fonction retourne un `ModelSnapshot` figé.

Exemple :

```json
{
  "model": {
    "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "server_id": "ollama-local",
    "display_name": "Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "base_model_name": "Mistral-7B-Instruct-v0.3"
  },
  "identity": {
    "provider": "mistral",
    "family": "mistral",
    "version": "7B-Instruct-v0.3",
    "revision": null,
    "checksum": null,
    "quantized_provider": "lmstudio-community"
  },
  "inference_server": {
    "server_id": "ollama-local",
    "display_name": "Local Ollama"
  },
  "runtime": {
    "retrieved_at": "2026-05-16T15:30:00Z",
    "source": "server",
    "server_software": {
      "name": "ollama",
      "version": "unknown",
      "build": null
    },
    "api": {
      "schema_family": ["ollama"],
      "api_version": null
    }
  },
  "endpoints": {
    "base_url": "http://localhost:11434",
    "health_url": null,
    "https": false
  },
  "auth": {
    "type": "none",
    "header_name": "Authorization",
    "token_env": null,
    "token": null,
    "token_present": false
  },
  "capabilities": {
    "server": {
      "streaming": true,
      "models_endpoint": true
    },
    "generation": {
      "text": true,
      "json_schema_output": true,
      "tools": false,
      "embeddings": false
    },
    "multimodal": {
      "vision": {
        "input_images": false,
        "output_images": false
      },
      "audio": {
        "input_audio": false,
        "output_audio": false
      }
    },
    "reasoning": {
      "exposed": false,
      "token_budget_configurable": false
    },
    "concurrency": {
      "parallel_requests": true,
      "parallel_tool_calls": false,
      "max_concurrent_requests": null
    },
    "enforcement": "server"
  },
  "discovery": {
    "retrieved_at": "2026-05-16T15:30:00Z",
    "ttl_seconds": 300,
    "model_list": {
      "raw": {},
      "normalised": []
    }
  },
  "model_metadata": {},
  "raw": {},
  "snapshot_quality": {
    "completeness": "partial",
    "sources": ["provider_api", "model_name_parse"],
    "warnings": ["quantisation inferred from model name; not confirmed by provider API"]
  }
}
```

### Données capturables

Selon le provider, certaines informations peuvent être indisponibles.

La fonction doit capturer autant que possible :

```text
- model.model_id
- model.server_id
- model.display_name
- model.base_model_name
- identity.provider
- identity.family
- identity.version
- identity.revision
- identity.checksum
- identity.quantized_provider
- architecture.type
- architecture.parameter_count
- architecture.parameter_count_label
- architecture.active_parameter_label
- architecture.precision
- architecture.format
- architecture.quantisation
- endpoints.base_url
- inference_server.server_version
- inference_server.server_software
- runtime.api.schema_family
- runtime.tokenizer si disponible
- runtime.context_window si disponible
- capabilities
- model_metadata
- hardware si disponible
- raw non sensible
- snapshot_quality
```

Si une information est indisponible, la valeur doit être :

```text
null
```

ou :

```text
unknown
```

### Décision de conception

Le `ModelSnapshot` doit être capturé pendant `instantiate_test()` et figé dans le `TestInstantiation`.

Il ne doit pas être recalculé pendant `run_test_instantiation()`, afin d’éviter qu’un run dépende d’un état modèle différent de celui capturé à l’instanciation.

---

## Sortie

La fonction retourne un `TestInstantiation`.

Exemple :

```json
{
  "kind": "test_instantiation",
  "schema_version": "benchmark_test_instantiation_v1",
  "instantiation_id": "test_20260514_001",
  "created_at": "2026-05-14T19:30:00Z",

  "template": {
    "template_id": "verbosity_ratio_v1",
    "template_version": "1.0.0",
    "snapshot": {
      "operation": "chat_completion",
      "stages": [
        {
          "id": "measure",
          "type": "dataset_loop",
          "iterations_per_item": 5,
          "record_metrics": true
        }
      ],
      "metrics": [
        "input_tokens",
        "output_tokens",
        "elapsed_ms"
      ],
      "aggregations": ["mean", "p95"]
    }
  },

  "model_profile": {
    "model": {
      "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
      "server_id": "ollama-local",
      "display_name": "Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
      "base_model_name": "Mistral-7B-Instruct-v0.3"
    },
    "identity": {
      "provider": "mistral",
      "family": "mistral",
      "version": "7B-Instruct-v0.3",
      "revision": null,
      "checksum": null,
      "quantized_provider": "lmstudio-community"
    },
    "architecture": {
      "type": "decoder-only",
      "parameter_count": null,
      "parameter_count_label": "7B",
      "active_parameter_label": null,
      "precision": "int4",
      "quantisation": {
        "method": "gguf",
        "bits": 4,
        "group_size": null,
        "scheme": "k-quant",
        "variant": "M",
        "weight_format": "Q4_K_M"
      },
      "format": "GGUF"
    },
    "inference_server": {
      "server_id": "ollama-local",
      "display_name": "Local Ollama"
    },
    "runtime": {
      "server_software": {
        "name": "ollama",
        "version": null,
        "build": null
      },
      "api": {
        "schema_family": ["ollama"],
        "api_version": null
      }
    },
    "endpoints": {
      "base_url": "http://localhost:11434"
    },
    "capabilities": {
      "server": {
        "streaming": true,
        "models_endpoint": true
      },
      "generation": {
        "text": true,
        "json_schema_output": true,
        "tools": false,
        "embeddings": false
      },
      "multimodal": {},
      "reasoning": {},
      "concurrency": {},
      "enforcement": "server"
    },
    "discovery": {
      "retrieved_at": "2026-05-14T19:30:00Z"
    }
  },

  "model_snapshot": {
    "model": {
      "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
      "server_id": "ollama-local",
      "display_name": "Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
      "base_model_name": "Mistral-7B-Instruct-v0.3"
    },
    "identity": {
      "provider": "mistral",
      "family": "mistral",
      "version": "7B-Instruct-v0.3",
      "revision": null,
      "checksum": null,
      "quantized_provider": "lmstudio-community"
    },
    "architecture": {
      "type": "decoder-only",
      "parameter_count": null,
      "parameter_count_label": "7B",
      "active_parameter_label": null,
      "precision": "int4",
      "quantisation": {
        "method": "gguf",
        "bits": 4,
        "group_size": null,
        "scheme": "k-quant",
        "variant": "M",
        "weight_format": "Q4_K_M"
      },
      "format": "GGUF"
    },
    "inference_server": {
      "server_id": "ollama-local",
      "display_name": "Local Ollama"
    },
    "runtime": {
      "retrieved_at": "2026-05-14T19:30:00Z",
      "source": "server",
      "server_software": {
        "name": "ollama",
        "version": "unknown",
        "build": null
      },
      "api": {
        "schema_family": ["ollama"],
        "api_version": null
      }
    },
    "endpoints": {
      "base_url": "http://localhost:11434",
      "health_url": null,
      "https": false
    },
    "auth": {
      "type": "none",
      "header_name": "Authorization",
      "token_env": null,
      "token": null,
      "token_present": false
    },
    "capabilities": {
      "server": {
        "streaming": true,
        "models_endpoint": true
      },
      "generation": {
        "text": true,
        "json_schema_output": true,
        "tools": false,
        "embeddings": false
      },
      "multimodal": {},
      "reasoning": {},
      "concurrency": {},
      "enforcement": "server"
    },
    "discovery": {
      "retrieved_at": "2026-05-14T19:30:00Z",
      "ttl_seconds": 300,
      "model_list": {
        "raw": {},
        "normalised": []
      }
    },
    "model_metadata": {},
    "raw": {},
    "snapshot_quality": {
      "completeness": "partial",
      "sources": ["provider_api", "model_name_parse"],
      "warnings": ["quantisation inferred from model name; not confirmed by provider API"]
    }
  },

  "operation_spec": {
    "method": "POST",
    "url": "http://localhost:11434/api/chat",
    "endpoint": "/api/chat",
    "protocol": "ollama_chat",
    "operation": "chat_completion"
  },

  "runtime_parameters": {
    "temperature": 0.2,
    "top_p": 0.9,
    "max_tokens": 512,
    "stream": false,
    "seed": 42,
    "stop": null,
    "presence_penalty": 0,
    "frequency_penalty": 0,
    "timeout_ms": 300000,
    "unsupported_parameter_policy": "strict"
  },

  "dataset": {
    "dataset_id": "verbosity_prompts_v1",
    "source": {
      "source_type": "file",
      "format": "jsonl",
      "path": "./datasets/verbosity_prompts.jsonl"
    },
    "canonicalization_version": "dataset_canonical_v1",
    "snapshot_policy": "manifest_only",
    "dataset_hash": "sha256:...",
    "item_count": 2,
    "item_hashes": [
      {
        "item_id": "p001",
        "hash": "sha256:..."
      }
    ],
    "item_manifest_ref": null,
    "snapshot_blob_ref": null
  }
}
```

## Décision de conception

Le moteur d’exécution doit consommer uniquement des `TestInstantiation`.

Le moteur ne doit pas :

```text
- aller rechercher un template externe
- recalculer des paramètres implicites
```

Le benchmark doit être autonome sur le plan de l’audit.

Pour les datasets, cette autonomie est assurée par le `DatasetManifest` :

```text
- dataset_hash
- item_count
- canonicalization_version
- item_hashes ou item_manifest_ref si disponibles
- snapshot_blob_ref si une version future active le stockage compressé
```

En v1, la politique par défaut est `manifest_only`.

## Checkpoint 1 Schema Limitation

The checkpoint-1 `test_instantiation.schema.json` keeps several embedded fields intentionally loose while the benchmark pipeline is still documented and validated as standalone schema contracts:

```text
- template.snapshot
- model_profile
- model_snapshot
- runtime_parameters
- execution_policy
- dataset
```

These openings are temporary and do not change the target contracts:

```text
template.snapshot    -> resolved test_template.schema.json snapshot shape
model_profile        -> model_profile.schema.json
model_snapshot       -> model_snapshot.schema.json
runtime_parameters   -> runtime_profile.schema.json#/runtime_parameters and inference-config.schema.json
execution_policy     -> runtime_profile.schema.json#/execution_policy
dataset              -> dataset_manifest.schema.json
```

The schemas stay standalone in checkpoint 1 because the local AJV validator compiles one schema file at a time. Hardening should therefore happen by inlining shared `$defs` into standalone schemas or by generating bundled standalone schemas. Do not add external `$ref` chains unless the validator is changed to register or bundle referenced schemas before compilation.

Each hardening step must validate the corresponding valid and invalid fixtures so examples remain aligned with the stricter contract.

## Erreurs attendues

La fonction doit signaler explicitement :

```text
- template invalide
- dataset invalide
- model_profile invalide
- model_snapshot impossible à capturer
- operation impossible à résoudre
- hash impossible à calculer
```

## Position dans l’architecture

```text
instantiate_test()
→ produit un TestInstantiation
→ persisté en base
→ exécuté plus tard par l'engine
```

---

---

# Fonction 0b — `run_test_instantiation()`

## Rôle

Exécuter un `TestInstantiation` figé et produire un `TestRunResult` complet.

Cette fonction est la façade principale du moteur d’exécution.

Elle répond à la question :

```text
Comment exécuter ce benchmark figé de bout en bout ?
```

## Signature proposée

```python
def run_test_instantiation(
    test_instantiation: dict
) -> dict:
```

## Paramètres d’entrée

### `test_instantiation: dict`

Objet JSON figé produit par `instantiate_test()`.

Il contient notamment :

```text
- template.snapshot
- model_profile
- model_snapshot
- operation_spec
- runtime_parameters
- dataset manifest
```

## Comportement attendu

La fonction doit :

```text
1. Lire les stages depuis template.snapshot
2. Lire le DatasetManifest depuis dataset
3. Résoudre les items exécutables selon dataset.snapshot_policy
4. Vérifier dataset_hash avant exécution lorsque le contenu est relu
5. Exécuter chaque stage via execute_test_stage()
6. Normaliser chaque réponse via normalise_response()
7. Calculer les métriques unitaires via compute_metrics()
8. Agréger les métriques via aggregate_metrics()
9. Produire un TestRunResult complet
```

Règles de résolution du dataset :

```text
embedded       → utiliser les items inclus dans le manifeste
manifest_only  → relire la source locale ou l’artefact référencé, puis vérifier dataset_hash
compressed_blob → réservé à une version future ; erreur explicite en v1 si aucun resolver n’est disponible
```

Si le contenu relu ne correspond pas au `dataset_hash`, l’exécution doit échouer avant tout appel modèle.

## Sortie

La fonction retourne un `TestRunResult`.

Exemple simplifié :

```json
{
  "kind": "test_run_result",
  "schema_version": "benchmark_test_run_result_v1",
  "run_id": "run_20260514_001",
  "instantiation_id": "test_20260514_001",
  "started_at": "2026-05-14T19:40:00Z",
  "completed_at": "2026-05-14T19:42:00Z",
  "status": "completed",
  "stage_results": [],
  "metric_results": [],
  "aggregated_metrics": {},
  "errors": [],
  "warnings": []
}
```

## Décision de conception

`run_test_instantiation()` est une fonction de façade.

Elle orchestre les fonctions du moteur, mais elle ne doit pas contenir directement :

```text
- logique provider-specific
- parsing dataset
- calcul détaillé des métriques
- logique HTTP bas niveau
```

Ces responsabilités restent déléguées aux fonctions spécialisées.

## Position dans l’architecture

```text
TestInstantiation
→ run_test_instantiation()
→ TestRunResult
```

---

# Fonction 1 — `resolve_operation_spec()`

## Rôle

Déduire la spécification HTTP concrète à partir d’un profil modèle et d’une opération logique demandée par un template.

Cette fonction répond à la question :

```text
Où et comment appeler le serveur d’inférence ?
```

Elle ne construit pas le payload métier. Elle ne gère pas les paramètres d’inférence tels que `temperature`, `top_p`, `max_tokens` ou `stream`, sauf si le support du streaming doit être exposé comme capacité.

## Signature proposée

```python
def resolve_operation_spec(
    model_profile: dict,
    model_snapshot: dict,
    operation: str,
    required_capabilities: dict | None = None
) -> dict:
```

## Paramètres d’entrée

### `model_profile: dict`

Profil du modèle sélectionné lors de l’instanciation du test.

Champs attendus :

```json
{
  "model": {
    "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "server_id": "ollama-local",
    "display_name": "Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
    "base_model_name": "Mistral-7B-Instruct-v0.3"
  },
  "identity": {
    "provider": "mistral",
    "family": "mistral",
    "version": "7B-Instruct-v0.3",
    "revision": null,
    "checksum": null,
    "quantized_provider": "lmstudio-community"
  },
  "inference_server": {
    "server_id": "ollama-local",
    "display_name": "Local Ollama"
  },
  "runtime": {
    "server_software": {
      "name": "ollama",
      "version": null,
      "build": null
    },
    "api": {
      "schema_family": ["ollama"],
      "api_version": null
    }
  },
  "endpoints": {
    "base_url": "http://localhost:11434"
  },
  "capabilities": {
    "server": {
      "streaming": true,
      "models_endpoint": true
    },
    "generation": {
      "text": true,
      "json_schema_output": true,
      "tools": false,
      "embeddings": false
    },
    "multimodal": {},
    "reasoning": {},
    "concurrency": {},
    "enforcement": "server"
  }
}
```

Champs obligatoires :

```text
model.model_id
model.server_id
identity.provider
identity.quantized_provider
endpoints.base_url
runtime.api.schema_family
```

Champs optionnels :

```text
capabilities
metadata
```

### `model_snapshot: dict`

Snapshot figé produit par `capture_model_snapshot()`.

Champs utilisés :

```text
runtime.api.schema_family
endpoints.base_url
capabilities
snapshot_quality
```

Le snapshot permet de vérifier que l’opération logique et les capabilities requises sont compatibles avec l’état réellement observé du modèle.

### `operation: str`

Opération logique demandée par le template.

Valeurs envisagées :

```text
chat_completion
completion
embedding
list_models
healthcheck
```

### `required_capabilities: dict | None`

Capabilities obligatoires déclarées par le `TestTemplate`.

Exemple :

```json
{
  "tool_calling": true,
  "structured_output": false
}
```

La fonction doit refuser l’opération si une capability obligatoire vaut `true` mais ne peut pas être résolue vers un champ compatible dans `model_snapshot.capabilities` ou `model_snapshot.model_capabilities`.

## Sortie

La fonction retourne un dictionnaire normalisé décrivant l’appel HTTP à effectuer.

Exemple pour Ollama / chat completion :

```json
{
  "method": "POST",
  "url": "http://localhost:11434/api/chat",
  "endpoint": "/api/chat",
  "protocol": "ollama_chat",
  "operation": "chat_completion",
  "supports_streaming": true,
  "supports_usage": false
}
```

Exemple pour OpenAI-compatible / chat completion :

```json
{
  "method": "POST",
  "url": "http://localhost:8000/v1/chat/completions",
  "endpoint": "/v1/chat/completions",
  "protocol": "openai_chat",
  "operation": "chat_completion",
  "supports_streaming": true,
  "supports_usage": true
}
```

## Règles de résolution

La résolution dépend du couple :

```text
runtime.api.schema_family + operation + capabilities canoniques observées
```

Exemples :

| Runtime schema family | Operation | Method | Endpoint | Protocol |
|---|---:|---:|---:|---:|
| `ollama` | `chat_completion` | `POST` | `/api/chat` | `ollama_chat` |
| `ollama` | `completion` | `POST` | `/api/generate` | `ollama_generate` |
| `ollama` | `embedding` | `POST` | `/api/embed` | `ollama_embedding` |
| `ollama` | `list_models` | `GET` | `/api/tags` | `ollama_list_models` |
| `openai-compatible` | `chat_completion` | `POST` | `/v1/chat/completions` | `openai_chat` |
| `openai-compatible` | `embedding` | `POST` | `/v1/embeddings` | `openai_embedding` |
| `openai-compatible` | `list_models` | `GET` | `/v1/models` | `openai_list_models` |

## Erreurs attendues

La fonction doit lever une erreur explicite dans les cas suivants :

```text
- runtime.api.schema_family manquant
- endpoints.base_url manquant
- model.model_id manquant pour les opérations nécessitant un modèle
- model_snapshot manquant ou invalide
- operation manquante
- operation inconnue
- capability obligatoire non détectée
- couple runtime.api.schema_family + operation non supporté
```

## Décisions de conception

Cette fonction ne doit pas :

```text
- construire le payload final
- appliquer les paramètres runtime du modèle
- charger le dataset
- exécuter la requête HTTP
- calculer les métriques
```

Elle doit uniquement produire la spécification de transport nécessaire à l’étape suivante.

## Exemple d’utilisation

```python
operation_spec = resolve_operation_spec(
    model_profile={
        "model": {
            "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
            "server_id": "ollama-local",
            "display_name": "Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M",
            "base_model_name": "Mistral-7B-Instruct-v0.3"
        },
        "identity": {
            "provider": "mistral",
            "quantized_provider": "lmstudio-community"
        },
        "inference_server": {
            "server_id": "ollama-local",
            "display_name": "Local Ollama"
        },
        "runtime": {
            "api": {
                "schema_family": ["ollama"],
                "api_version": None
            }
        },
        "endpoints": {
            "base_url": "http://localhost:11434"
        }
    },
    model_snapshot={
        "runtime": {
            "api": {
                "schema_family": ["ollama"],
                "api_version": None
            }
        },
        "endpoints": {
            "base_url": "http://localhost:11434"
        },
        "capabilities": {
            "server": {
                "streaming": True,
                "models_endpoint": True
            },
            "generation": {
                "text": True,
                "json_schema_output": True,
                "tools": False,
                "embeddings": False
            },
            "enforcement": "server"
        },
        "snapshot_quality": {
            "completeness": "partial",
            "sources": ["provider_api"],
            "warnings": []
        }
    },
    operation="chat_completion",
    required_capabilities={
        "chat_completion": True
    }
)
```

Résultat :

```python
{
    "method": "POST",
    "url": "http://localhost:11434/api/chat",
    "endpoint": "/api/chat",
    "protocol": "ollama_chat",
    "operation": "chat_completion",
    "supports_streaming": True,
    "supports_usage": False
}
```

---

# Fonction 2 — `prepare_dataset()`

## Rôle

Charger, valider et normaliser un dataset afin de produire une liste d’items prêts à être consommés par les étapes de test.

Cette fonction prépare le contenu en mémoire pour l’instanciation et l’exécution.

Elle ne décide pas, à elle seule, si le contenu complet sera embarqué dans le `TestInstantiation`.

La politique de stockage du dataset est gérée par `build_dataset_manifest()`.

Cette fonction répond à la question :

```text
Quelles entrées de test doivent être exécutées, et sous quelle forme normalisée ?
```

Elle doit supporter plusieurs modes de fourniture du dataset :

```text
inline
file
url
```

Elle doit aussi supporter plusieurs formats de fichier ou de contenu :

```text
json
jsonl
csv
```

`jsonl` est recommandé pour les datasets de taille moyenne ou grande, car il permet de lire et versionner un item par ligne.

## Signature proposée

```python
def prepare_dataset(
    dataset_spec: dict,
    input_contract: dict | None = None
) -> dict:
```

## Paramètres d’entrée

### `dataset_spec: dict`

Décrit la source du dataset et son format.

Exemple inline :

```json
{
  "source_type": "inline",
  "format": "json",
  "items": [
    {
      "id": "p001",
      "prompt": "Explain RAG in simple terms.",
      "tags": ["rag", "simple"]
    }
  ]
}
```

Exemple fichier local :

```json
{
  "source_type": "file",
  "format": "jsonl",
  "path": "./datasets/verbosity_prompts.jsonl"
}
```

Exemple URL :

```json
{
  "source_type": "url",
  "format": "csv",
  "url": "https://example.org/datasets/prompts.csv"
}
```

Champs obligatoires :

```text
source_type
format
```

Champs conditionnels :

```text
items  → obligatoire si source_type = inline
path   → obligatoire si source_type = file
url    → obligatoire si source_type = url
```

### `input_contract: dict | None`

Contrat attendu par le template de test.

Exemple :

```json
{
  "required_fields": ["prompt"],
  "optional_fields": [
    "id",
    "system_prompt",
    "interaction_mode",
    "tools",
    "expected_tool_calls",
    "tool_result",
    "expected_answer",
    "expected_format",
    "expected_schema",
    "tags",
    "metadata"
  ],
  "min_items": 1
}
```

Ce contrat permet au template d’exprimer ce dont il a besoin sans connaître la source concrète du dataset.

## Format normalisé d’un item dataset

Chaque item doit être converti vers une structure interne stable.

```json
{
  "id": "p001",
  "prompt": "Explain RAG in simple terms.",
  "system_prompt": null,
  "interaction_mode": "chat",
  "tools": [],
  "expected_tool_calls": [],
  "tool_result": null,
  "expected_answer": null,
  "expected_format": "free_text",
  "expected_schema": null,
  "evaluation": null,
  "tags": ["rag", "simple"],
  "metadata": {}
}
```

## Champs recommandés

### `id`

Identifiant stable de l’item.

Si absent, la fonction peut générer un identifiant déterministe, par exemple :

```text
dataset_item_000001
```

### `prompt`

Champ obligatoire dans la majorité des tests.

Il contient l’instruction utilisateur principale.

### `system_prompt`

Optionnel.

Permet de tester l’impact d’un contexte système ou d’un rôle imposé.

### `interaction_mode`

Optionnel, avec valeur par défaut :

```text
chat
```

Décrit le mode d’interaction attendu pour l’item.

Valeurs proposées :

```text
chat
tool_calling
structured_output
multi_turn
agentic
```

Ce champ permet au dataset de couvrir autre chose que du prompt brut. Il conditionne la construction future du payload et l’évaluation de la réponse.

### `tools`

Optionnel.

Liste des outils disponibles pour l’item lorsque `interaction_mode = tool_calling` ou `agentic`.

Format proposé, proche du modèle OpenAI-compatible :

```json
[
  {
    "name": "get_weather",
    "description": "Retrieve current weather for a city.",
    "parameters": {
      "type": "object",
      "properties": {
        "city": { "type": "string" }
      },
      "required": ["city"]
    }
  }
]
```

### `expected_tool_calls`

Optionnel.

Liste des appels d’outils attendus.

Exemple :

```json
[
  {
    "tool": "get_weather",
    "arguments": {
      "city": "Paris"
    }
  }
]
```

Ce champ permet d’évaluer :

```text
- si le bon outil a été sélectionné
- si les arguments sont valides
- si les arguments correspondent à l’attendu
- si l’appel d’outil complet passe l’assertion attendue
- si le modèle a halluciné un outil non disponible
- si le modèle a omis un outil attendu
```

Les arguments attendus doivent être comparés par égalité structurelle exacte :
l’ordre des clés JSON n’est pas significatif, mais les types le sont. Par
exemple `"42"` ne doit pas être considéré égal à `42`.

### `tool_result`

Optionnel.

Résultat d’outil statique injectable lorsque `interaction_mode = agentic`.

Exemple :

```json
{
  "tool_name": "get_weather",
  "content": "Paris weather: 14 C, light rain."
}
```

Ce champ permet un scénario agentique déterministe sans exécuter de vrais
outils. Pour `interaction_mode = agentic`, l’ordre des items est significatif :
le dataset représente un seul scénario, chaque item représente le prochain tour
utilisateur attendu, et le runner accumule le transcript réel. En v1,
`expected_tool_calls` doit contenir zéro ou un appel. Si un appel est attendu,
`tool_result` est obligatoire ; le runner vérifie l’appel, injecte ce résultat
statique, envoie une seule requête de suivi, puis évalue `expected_answer` sur la
réponse finale. Si aucun appel n’est attendu, `tool_result` doit être absent et
`expected_answer` s’applique à la réponse directe.

### `expected_answer`

Optionnel.

Utile pour les tests de conformité simples, par exemple lorsqu’une réponse exacte ou quasi exacte est attendue.

Exemple :

```json
{
  "id": "capital_france",
  "prompt": "What is the capital of France?",
  "expected_answer": "Paris"
}
```

### `expected_format`

Optionnel, avec valeur par défaut :

```text
free_text
```

Valeurs proposées :

```text
free_text
json
markdown
code
boolean
number
schema
regex
```

### `expected_schema`

Optionnel.

Utile si `expected_format = schema` ou `json`.

Exemple :

```json
{
  "type": "object",
  "required": ["name", "age"],
  "properties": {
    "name": { "type": "string" },
    "age": { "type": "integer" }
  }
}
```

### `evaluation`

Optionnel.

Décrit comment l’item doit être évalué.

Exemples :

```json
{
  "type": "exact_match",
  "case_sensitive": false
}
```

```json
{
  "type": "contains",
  "required_terms": ["retrieval", "generation"]
}
```

```json
{
  "type": "regex",
  "pattern": "^[A-Z]{3}-[0-9]{4}$"
}
```

```json
{
  "type": "json_schema"
}
```

### `tags`

Optionnel.

Permet de filtrer, grouper ou analyser les résultats par catégorie.

### `metadata`

Optionnel.

Permet d’ajouter des informations non standard sans casser le schéma : difficulté, domaine, langue, source, auteur, version, etc.

## Formats supportés

### JSON

Format recommandé pour les petits datasets ou les datasets riches.

Structure attendue :

```json
{
  "dataset_id": "basic_prompt_tests_v1",
  "format_version": "prompt_dataset_v1",
  "items": [
    {
      "id": "p001",
      "prompt": "Explain RAG in simple terms.",
      "expected_format": "free_text"
    }
  ]
}
```

### JSONL

Format recommandé pour les datasets volumineux.

Une ligne = un item.

```jsonl
{"id":"p001","prompt":"Explain RAG in simple terms.","expected_format":"free_text"}
{"id":"p002","prompt":"Return a valid JSON object with name and age.","expected_format":"json"}
```

### CSV

Format simple, utile pour édition dans un tableur.

Colonnes minimales :

```text
id,prompt,expected_answer,expected_format,tags
```

Exemple :

```csv
id,prompt,expected_answer,expected_format,tags
p001,What is the capital of France?,Paris,free_text,"geography;simple"
p002,Return a JSON object with name and age,,json,"json;format"
```

Convention proposée :

```text
tags séparés par ;
metadata éventuellement encodé en JSON string
expected_schema éventuellement encodé en JSON string
```

## Sortie

La fonction retourne un dictionnaire normalisé utilisable par le moteur.

```python
{
    "dataset_id": "basic_prompt_tests_v1",
    "source_type": "file",
    "format": "jsonl",
    "item_count": 2,
    "items": [
        {
            "id": "p001",
            "prompt": "Explain RAG in simple terms.",
            "system_prompt": None,
            "interaction_mode": "chat",
            "tools": [],
            "expected_tool_calls": [],
            "expected_answer": None,
            "expected_format": "free_text",
            "expected_schema": None,
            "evaluation": None,
            "tags": ["rag", "simple"],
            "metadata": {}
        }
    ],
    "warnings": []
}
```

Cette sortie peut être utilisée ensuite pour :

```text
- calculer dataset_hash
- calculer item_hashes
- construire un DatasetManifest
- exécuter un stage si les items sont disponibles en mémoire
```

## Erreurs attendues

La fonction doit lever une erreur explicite dans les cas suivants :

```text
- source_type manquant
- format manquant
- source_type inconnu
- format inconnu
- fichier introuvable
- URL inaccessible
- contenu invalide
- champ obligatoire absent
- dataset vide
- expected_schema invalide
- tools invalide
- expected_tool_calls invalide
- interaction_mode = tool_calling sans tools, si le contrat du template l’exige
- CSV sans colonne prompt si prompt est requis
```

## Décisions de conception

Cette fonction ne doit pas :

```text
- construire le payload final provider
- appeler le modèle
- calculer les métriques
- évaluer la réponse du modèle
```

Elle doit uniquement préparer les entrées de test.

## Recommandation

Prévoir dès maintenant les champs évaluatifs et interactionnels suivants, même s’ils ne sont pas utilisés par tous les tests :

```text
interaction_mode
tools
expected_tool_calls
expected_answer
expected_format
expected_schema
evaluation
```

Cela évite de limiter le dataset aux seuls tests de performance. Le même format pourra servir à des tests de conformité, de respect de format, d’instruction following, de tool calling, d’agentic behaviour ou de scoring simple.

## Exemple d’utilisation

```python
dataset = prepare_dataset(
    dataset_spec={
        "source_type": "file",
        "format": "jsonl",
        "path": "./datasets/standards_compliance.jsonl"
    },
    input_contract={
        "required_fields": ["prompt"],
        "optional_fields": ["interaction_mode", "tools", "expected_tool_calls", "expected_answer", "expected_format", "expected_schema", "evaluation"],
        "min_items": 1
    }
)
```


---

# Fonction 2b — `build_dataset_manifest()`

## Rôle

Construire le manifeste vérifiable du dataset réellement utilisé par un benchmark.

Cette fonction répond à la question :

```text
Quelle preuve persistable permet de savoir quel dataset exact a été utilisé ?
```

## Signature proposée

```python
def build_dataset_manifest(
    prepared_dataset: dict,
    dataset_spec: dict,
    snapshot_policy: str = "manifest_only"
) -> dict:
```

## Paramètres d’entrée

### `prepared_dataset: dict`

Dataset normalisé produit par `prepare_dataset()`.

### `dataset_spec: dict`

Spécification source du dataset.

### `snapshot_policy: str`

Politique de stockage à appliquer.

Valeurs proposées :

```text
embedded
manifest_only
compressed_blob
```

Valeur par défaut v1 :

```text
manifest_only
```

## Sortie

La fonction retourne un `DatasetManifest`.

Exemple `manifest_only` :

```json
{
  "dataset_id": "basic_prompt_tests_v1",
  "source": {
    "source_type": "file",
    "format": "jsonl",
    "path": "./datasets/prompts.jsonl"
  },
  "canonicalization_version": "dataset_canonical_v1",
  "snapshot_policy": "manifest_only",
  "dataset_hash": "sha256:...",
  "item_count": 2500,
  "item_hashes": null,
  "item_manifest_ref": null,
  "snapshot_blob_ref": null
}
```

## Comportement attendu

La fonction doit :

```text
1. Canonicaliser les items normalisés selon canonicalization_version
2. Calculer dataset_hash
3. Calculer item_count
4. Inclure item_hashes si la politique ou la taille le permet
5. Inclure item_manifest_ref si les hashes par item sont externalisés
6. Inclure snapshot_blob_ref uniquement si un artefact compressé existe
7. Retourner un manifeste autonome et persistable
```

## Erreurs attendues

La fonction doit signaler explicitement :

```text
- prepared_dataset invalide
- dataset_spec invalide
- snapshot_policy inconnue
- canonicalisation impossible
- dataset_hash impossible à calculer
- item_hash impossible à calculer
- compressed_blob demandé sans artefact disponible en v1
```

## Décision de conception

En v1 :

```text
- manifest_only est le comportement cible
- compressed_blob est autorisé par le schéma mais non implémenté
- embedded est réservé aux petits datasets ou aux tests unitaires
```

Cette fonction ne doit pas :

```text
- exécuter le benchmark
- appeler le modèle
- décider des métriques
- compresser le dataset en v1
```

---

# Fonction 3 — `build_request_payload()`

## Rôle

Construire le payload JSON final qui sera envoyé au serveur d’inférence, à partir :

```text
- du protocole résolu par resolve_operation_spec()
- du profil modèle
- des paramètres runtime
- d’un item dataset normalisé
```

Cette fonction répond à la question :

```text
Quel corps JSON doit être envoyé au provider pour cet item de test ?
```

Elle convertit une représentation interne stable vers le format attendu par le provider.

## Signature proposée

```python
def build_request_payload(
    operation_spec: dict,
    model_profile: dict,
    runtime_parameters: dict,
    dataset_item: dict
) -> dict:
```

## Paramètres d’entrée

### `operation_spec: dict`

Résultat produit par `resolve_operation_spec()`.

Champs utilisés :

```text
protocol
operation
supports_streaming
```

Exemple :

```json
{
  "method": "POST",
  "url": "http://localhost:11434/api/chat",
  "endpoint": "/api/chat",
  "protocol": "ollama_chat",
  "operation": "chat_completion",
  "supports_streaming": true,
  "supports_usage": false
}
```

### `model_profile: dict`

Profil du modèle sélectionné pour l’exécution.

Champs utilisés :

```text
runtime.api.schema_family
model.model_id
```

Exemple :

```json
{
  "model": {
    "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M"
  },
  "runtime": {
    "api": {
      "schema_family": ["ollama"],
      "api_version": null
    }
  }
}
```

### `runtime_parameters: dict`

Paramètres manuels définis lors de l’instanciation du test.

Ces paramètres utilisent le vocabulaire canonique de `inference-config.schema.json`. La construction du payload provider-specific doit adapter ces noms au protocole cible au moment de l'exécution, sans introduire un autre contrat public de paramètres.

Exemple :

```json
{
  "temperature": 0.2,
  "top_p": 0.9,
  "max_tokens": 512,
  "stream": false,
  "seed": 42,
  "stop": null,
  "presence_penalty": 0,
  "frequency_penalty": 0,
  "timeout_ms": 300000,
  "unsupported_parameter_policy": "strict"
}
```

### `dataset_item: dict`

Item normalisé produit par `prepare_dataset()`.

Exemple :

```json
{
  "id": "p001",
  "prompt": "Explain RAG in simple terms.",
  "system_prompt": null,
  "interaction_mode": "chat",
  "tools": [],
  "expected_tool_calls": [],
  "expected_answer": null,
  "expected_format": "free_text",
  "expected_schema": null,
  "evaluation": null,
  "tags": ["rag", "simple"],
  "metadata": {}
}
```

## Sortie

La fonction retourne le payload JSON provider-specific.

Elle ne retourne pas l’URL, la méthode HTTP ou les headers. Ces informations restent dans `operation_spec` ou dans une fonction dédiée ultérieure.

## Exemple de sortie — Ollama chat

```json
{
  "model": "qwen2.5:7b-instruct-q4_K_M",
  "messages": [
    {
      "role": "user",
      "content": "Explain RAG in simple terms."
    }
  ],
  "stream": false,
  "options": {
    "temperature": 0.2,
    "top_p": 0.9,
    "num_predict": 512,
    "seed": 42
  }
}
```

## Exemple de sortie — OpenAI-compatible chat

```json
{
  "model": "gpt-4.1",
  "messages": [
    {
      "role": "user",
      "content": "Explain RAG in simple terms."
    }
  ],
  "temperature": 0.2,
  "top_p": 0.9,
  "max_tokens": 512,
  "stream": false,
  "seed": 42
}
```

## Construction des messages

La fonction doit convertir `system_prompt` et `prompt` en liste de messages.

Sans `system_prompt` :

```json
[
  {
    "role": "user",
    "content": "Explain RAG in simple terms."
  }
]
```

Avec `system_prompt` :

```json
[
  {
    "role": "system",
    "content": "You are a concise assistant."
  },
  {
    "role": "user",
    "content": "Explain RAG in simple terms."
  }
]
```

## Support du tool calling

Si `dataset_item.interaction_mode = tool_calling`, la fonction doit inclure les outils dans le payload lorsque le protocole le supporte.

### OpenAI-compatible

```json
{
  "model": "gpt-4.1",
  "messages": [
    {
      "role": "user",
      "content": "What is the weather in Paris?"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Retrieve current weather for a city.",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string" }
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

### Ollama

Pour Ollama, le support dépend du modèle et de l’API utilisée. Si le protocole ou le modèle ne supporte pas les tools, la fonction doit lever une erreur explicite ou ignorer les tools uniquement si une option permissive est prévue plus tard.

Décision recommandée :

```text
mode strict par défaut → erreur si tool_calling demandé mais non supporté
```

## Support du structured output

Si `dataset_item.interaction_mode = structured_output` ou si `expected_format = json/schema`, la fonction peut ajouter une contrainte de format lorsque le protocole le supporte.

Exemple OpenAI-compatible :

```json
{
  "response_format": {
    "type": "json_object"
  }
}
```

Exemple Ollama :

```json
{
  "format": "json"
}
```

Si `expected_schema` est défini, son exploitation dépendra du provider. Par défaut, la fonction doit au minimum conserver cette information pour la construction du payload si le protocole le supporte.

## Paramètres runtime canoniques

Paramètres supportés par `inference-config.schema.json` et par `runtime_profile.schema.json` :

```text
temperature
top_p
max_tokens
stream
seed
stop
presence_penalty
frequency_penalty
timeout_ms
unsupported_parameter_policy
```

## Gestion des paramètres non supportés

Deux politiques sont possibles :

```text
strict
permissive
```

Recommandation initiale : `strict`.

En mode strict :

```text
- un paramètre non supporté par le protocole provoque une erreur
```

En mode permissive :

```text
- le paramètre est ignoré
- un warning est ajouté ailleurs dans le pipeline
```

Le choix de cette politique pourra devenir un paramètre global ultérieur, par exemple :

```json
{
  "unsupported_parameter_policy": "strict"
}
```

## Erreurs attendues

La fonction doit lever une erreur explicite dans les cas suivants :

```text
- operation_spec.protocol manquant
- model_profile.model.model_id manquant
- dataset_item.prompt manquant pour chat/completion
- interaction_mode inconnu
- interaction_mode = tool_calling sans tools
- tool_calling demandé mais non supporté par le protocole
- runtime parameter non supporté en mode strict
- structured output demandé mais non supporté par le protocole
```

## Décisions de conception

Cette fonction ne doit pas :

```text
- résoudre l’URL ou l’endpoint
- charger le dataset
- appeler le serveur HTTP
- mesurer la latence
- normaliser la réponse
- calculer les métriques
```

Elle doit uniquement construire le corps JSON de la requête.

## Exemple d’utilisation

```python
payload = build_request_payload(
    operation_spec=operation_spec,
    model_profile={
        "model": {
            "model_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF-Q4_K_M"
        },
        "runtime": {
            "api": {
                "schema_family": ["ollama"],
                "api_version": None
            }
        }
    },
    runtime_parameters={
        "temperature": 0.2,
        "top_p": 0.9,
        "max_tokens": 512,
        "stream": False
    },
    dataset_item={
        "id": "p001",
        "prompt": "Explain RAG in simple terms.",
        "system_prompt": None,
        "interaction_mode": "chat",
        "tools": [],
        "expected_tool_calls": [],
        "expected_format": "free_text"
    }
)
```

## Position dans le pipeline

```text
resolve_operation_spec()
→ prepare_dataset()
→ build_request_payload()
→ execute_test_stage()
    → execute_http_request()
→ normalise_response()
→ compute_metrics()
```

---

# Fonction 4 — `execute_test_stage()`

## Rôle

Orchestrer l’exécution d’un stage de test sur un dataset normalisé.

Cette fonction répond à la question :

```text
Combien de fois, dans quel ordre, et selon quelles règles doit-on exécuter les requêtes d’un stage ?
```

Elle gère les boucles d’exécution :

```text
stage
→ dataset item
→ iteration
→ requête HTTP unitaire
```

Elle ne doit pas contenir la logique bas niveau de transport HTTP. Chaque appel unitaire est délégué à `execute_http_request()`.

## Signature proposée

```python
def execute_test_stage(
    stage_spec: dict,
    operation_spec: dict,
    model_profile: dict,
    runtime_parameters: dict,
    dataset: dict,
    headers: dict | None = None
) -> dict:
```

## Paramètres d’entrée

### `stage_spec: dict`

Décrit le comportement d’exécution du stage.

Exemple simple :

```json
{
  "id": "measure",
  "type": "dataset_loop",
  "iterations_per_item": 5,
  "record_metrics": true,
  "order": "sequential"
}
```

Exemple avec warmup :

```json
{
  "id": "warmup",
  "type": "dataset_loop",
  "iterations_per_item": 2,
  "record_metrics": false,
  "order": "sequential"
}
```

Champs recommandés :

```text
id
type
iterations_per_item
record_metrics
order
cooldown_ms
pre_iteration_delay_ms
intra_pair_delay_ms
pair
derived_metrics
observability
stop_on_error
```

Valeurs proposées pour `type` :

```text
dataset_loop
single_request
paired_request_loop
```

Valeurs proposées pour `order` :

```text
sequential
random
```

La concurrence peut être ajoutée plus tard via :

```text
parallel
concurrency
rate_limit
```

### `operation_spec: dict`

Résultat de `resolve_operation_spec()`.

Utilisé pour connaître :

```text
method
url
protocol
operation
```

### `model_profile: dict`

Profil du modèle testé.

Transmis à `build_request_payload()`.

### `runtime_parameters: dict`

Paramètres runtime appliqués à chaque requête du stage.

Exemple :

```json
{
  "temperature": 0.2,
  "top_p": 0.9,
  "max_tokens": 512,
  "stream": false,
  "timeout_ms": 300000
}
```

### `dataset: dict`

Dataset normalisé produit par `prepare_dataset()`.

Structure attendue :

```json
{
  "dataset_id": "basic_prompt_tests_v1",
  "source_type": "file",
  "format": "jsonl",
  "item_count": 2,
  "items": [
    {
      "id": "p001",
      "prompt": "Explain RAG in simple terms.",
      "interaction_mode": "chat"
    }
  ],
  "warnings": []
}
```

### `headers: dict | None`

Headers HTTP optionnels.

Exemple :

```json
{
  "Authorization": "Bearer xxx",
  "Content-Type": "application/json"
}
```

## Sortie

La fonction retourne un dictionnaire décrivant les résultats bruts du stage.

```python
{
    "stage_id": "measure",
    "stage_type": "dataset_loop",
    "record_metrics": True,
    "run_count": 10,
    "results": [
        {
            "stage_id": "measure",
            "dataset_item_id": "p001",
            "iteration": 1,
            "payload": {},
            "http_result": {},
            "record_metrics": True
        }
    ],
    "errors": [],
    "warnings": []
}
```

Pour un stage pairé, la sortie doit conserver les membres de paire :

```python
{
    "stage_id": "cold-hot",
    "stage_type": "paired_request_loop",
    "record_metrics": True,
    "run_count": 10,
    "pair_results": [
        {
            "dataset_item_id": "ok",
            "iteration": 1,
            "members": {
                "cold": {
                    "http_result": {},
                    "normalized_response": {},
                    "metrics": { "elapsed_ms": 1800.0 }
                },
                "hot": {
                    "http_result": {},
                    "normalized_response": {},
                    "metrics": { "elapsed_ms": 650.0 }
                }
            },
            "derived_metrics": {
                "cold_total_ms": 1800.0,
                "hot_total_ms": 650.0,
                "cold_penalty_ms": 1150.0
            }
        }
    ],
    "errors": [],
    "warnings": []
}
```

## Comportement attendu

Pour un stage `dataset_loop`, la fonction doit :

```text
1. Lire la liste des items du dataset
2. Appliquer l’ordre demandé : sequential ou random
3. Pour chaque item, exécuter N itérations
4. Construire le payload via build_request_payload()
5. Appeler execute_http_request()
6. Stocker le résultat brut avec stage_id, item_id et iteration
7. Appliquer cooldown_ms si défini
8. Continuer ou arrêter selon stop_on_error
```

Pour un stage `paired_request_loop`, la fonction doit :

```text
1. Lire la liste des items du dataset
2. Appliquer l'ordre demandé : sequential ou random
3. Pour chaque item, exécuter N itérations
4. Appliquer pre_iteration_delay_ms si défini
5. Pour chaque membre de pair[], construire le payload via build_request_payload()
6. Appeler execute_http_request()
7. Normaliser et enregistrer le résultat avec pair_member_id
8. Appliquer intra_pair_delay_ms entre deux membres si défini
9. Calculer les métriques unitaires de chaque membre
10. Calculer les métriques dérivées de la paire
11. Continuer ou arrêter selon stop_on_error
```

## Gestion des itérations

L’itération est une propriété du stage, pas du dataset, du payload ou de la requête HTTP.

Hiérarchie retenue :

```text
Test
└── Stage
    └── Dataset item
        └── Iteration
            └── HTTP request
```

Pour les stages pairés, la hiérarchie devient :

```text
Test
└── Stage
    └── Dataset item
        └── Iteration
            └── Pair member
                └── HTTP request
```

Exemple :

```json
{
  "id": "measure",
  "type": "dataset_loop",
  "iterations_per_item": 5,
  "record_metrics": true
}
```

Si le dataset contient 10 items et `iterations_per_item = 5`, alors le stage produit 50 appels HTTP unitaires.

Si un stage `paired_request_loop` contient 2 membres et que le dataset contient
10 items avec `iterations_per_item = 5`, alors le stage produit 100 appels HTTP
unitaires et 50 résultats pairés.

## `record_metrics`

Le champ `record_metrics` permet de distinguer :

```text
- les stages de warmup
- les stages de mesure
- les stages techniques
```

Exemple :

```json
{
  "id": "warmup",
  "type": "dataset_loop",
  "iterations_per_item": 2,
  "record_metrics": false
}
```

Les résultats peuvent être conservés pour audit, mais ne doivent pas être inclus dans les agrégations finales si `record_metrics = false`.

## `stop_on_error`

Valeurs proposées :

```text
true
false
```

Comportement :

```text
true  → arrêt du stage dès la première erreur
false → erreur enregistrée, le stage continue
```

Valeur par défaut recommandée :

```text
false
```

## `cooldown_ms`

Pause optionnelle entre deux requêtes.

Utile pour :

```text
- éviter de saturer un serveur local
- stabiliser les mesures
- tester des scénarios cold/hot avec délai contrôlé
```

## Types de stage envisagés

### `dataset_loop`

Cas standard.

Chaque item du dataset est joué `iterations_per_item` fois.

### `single_request`

Un seul item ou une seule requête technique.

Utile pour :

```text
healthcheck
list_models
warmup simple
```

### `paired_request_loop`

Deux requêtes liées sont exécutées et comparées.

Utile pour :

```text
cold_start_penalty
A/B prompt comparison
cache effect
```

Ce type est nécessaire pour représenter une famille de benchmarks où deux
requêtes liées doivent être comparées dans la même itération. `cold_start_penalty`
est seulement un exemple de cette famille, pas une référence normative.

Structure générale :

```text
Stage
└── Dataset item
    └── Iteration
        ├── Pair member: <baseline>
        │   └── HTTP request
        └── Pair member: <comparison>
            └── HTTP request
```

Exemple de stage :

```json
{
  "id": "cold-start-measure",
  "type": "paired_request_loop",
  "iterations_per_item": 5,
  "record_metrics": true,
  "order": "sequential",
  "pre_iteration_delay_ms": 31000,
  "intra_pair_delay_ms": 0,
  "pair": [
    {
      "id": "cold",
      "role": "baseline",
      "request": { "reuse": "default" }
    },
    {
      "id": "hot",
      "role": "comparison",
      "request": { "reuse": "default" }
    }
  ],
  "derived_metrics": [
    {
      "id": "cold_penalty_ms",
      "type": "difference",
      "left": "cold.elapsed_ms",
      "right": "hot.elapsed_ms",
      "unit": "ms"
    }
  ]
}
```

Sémantique :

```text
pre_iteration_delay_ms
→ pause avant le premier membre de chaque paire

intra_pair_delay_ms
→ pause entre les membres d'une même paire

pair[].id
→ label stable utilisé dans les résultats et les métriques dérivées

pair[].request.reuse = "default"
→ utiliser le payload normal produit par build_request_payload()
```

Pour un test de pénalité de cold start, par exemple, la première requête de
chaque paire peut être étiquetée `cold`, la seconde `hot`, et une métrique
dérivée utile peut être :

```text
cold_penalty_ms = cold.elapsed_ms - hot.elapsed_ms
```

Un champ spécifique au domaine, tel que `cold_condition`, peut être ajouté dans
`stage_spec.metadata` ou `stage_spec.observability` pour documenter l'intention
de mesure :

```json
{
  "observability": {
    "cold_condition": {
      "mode": "unload",
      "note": "True cold depends on server eviction/model residency behaviour."
    }
  }
}
```

Le moteur ne doit pas présumer qu'il peut exécuter une action technique non
déclarée par le provider, comme évacuer un modèle de la mémoire. S'il ne dispose
pas d'une opération explicite d'unload/eviction, il doit seulement enregistrer
l'intention et appliquer les délais configurés.

Les résultats d'un `paired_request_loop` doivent conserver :

```text
- les mesures unitaires de chaque membre de paire
- le label de membre (`cold`, `hot`, etc.)
- les métriques dérivées par itération
- les agrégations finales sur les métriques dérivées
```

### Exemple illustratif : pénalité de cold start

Un test équivalent à un script `cold_start_penalty` doit pouvoir être représenté
comme un `TestTemplate` déclaratif. Cet exemple sert uniquement à valider que le
modèle supporte les boucles pairées et les métriques dérivées. Les futurs tests
peuvent utiliser d'autres labels, d'autres délais et d'autres métriques dérivées.

Exemple :

```json
{
  "kind": "test_template",
  "schema_version": "benchmark_test_template_v1",
  "template_id": "perf.cold_start_penalty.v1",
  "template_version": "1.0.0",
  "name": "Cold start penalty",
  "description": "Estimate model cold-start penalty by comparing first request latency with immediate follow-up latency.",
  "operation": "chat_completion",
  "required_capabilities": {
    "chat_completion": true,
    "streaming": false
  },
  "input_contract": {
    "required_fields": ["messages"],
    "optional_fields": ["id", "tags", "metadata"],
    "min_items": 1
  },
  "stages": [
    {
      "id": "cold-hot",
      "type": "paired_request_loop",
      "iterations_per_item": 5,
      "record_metrics": true,
      "order": "sequential",
      "pre_iteration_delay_ms": 31000,
      "intra_pair_delay_ms": 0,
      "pair": [
        { "id": "cold", "role": "baseline", "request": { "reuse": "default" } },
        { "id": "hot", "role": "comparison", "request": { "reuse": "default" } }
      ],
      "derived_metrics": [
        {
          "id": "cold_penalty_ms",
          "type": "difference",
          "left": "cold.elapsed_ms",
          "right": "hot.elapsed_ms",
          "unit": "ms"
        }
      ],
      "observability": {
        "cold_condition": {
          "mode": "unload",
          "note": "If the server supports eviction, a future adapter may execute it before the cold member."
        }
      }
    }
  ],
  "metrics": [
    "pair.cold.elapsed_ms",
    "pair.hot.elapsed_ms",
    "cold_penalty_ms",
    "elapsed_ms"
  ],
  "aggregations": ["median", "mean", "p95"]
}
```

Dataset minimal correspondant :

```json
{
  "dataset_id": "cold_start_ok_prompt_v1",
  "items": [
    {
      "id": "ok",
      "messages": [
        { "role": "system", "content": "You are a concise assistant." },
        { "role": "user", "content": "Reply with exactly: OK" }
      ]
    }
  ]
}
```

Paramètres runtime correspondants :

```json
{
  "temperature": 0,
  "max_tokens": 64,
  "stream": false,
  "timeout_ms": 300000
}
```

Le moteur résout ensuite l'endpoint concret via `operation_spec`. Le template ne
doit pas contenir `/v1/chat/completions`, `/api/chat`, ni un autre endpoint
provider-specific.

## Erreurs attendues

La fonction doit lever ou enregistrer une erreur explicite dans les cas suivants :

```text
- stage_spec.id manquant
- stage_spec.type manquant
- type de stage inconnu
- iterations_per_item invalide ou inférieur à 1
- dataset vide pour dataset_loop
- dataset.items manquant
- erreur lors de build_request_payload()
- erreur lors de execute_http_request()
```

Le comportement exact dépend de `stop_on_error`.

## Décisions de conception

Cette fonction ne doit pas :

```text
- résoudre l’endpoint HTTP
- charger le dataset
- connaître les détails provider-specific du payload
- normaliser la réponse modèle
- calculer les métriques finales
- agréger les résultats
```

Elle doit uniquement orchestrer les exécutions unitaires d’un stage.

## Exemple d’utilisation

```python
stage_result = execute_test_stage(
    stage_spec={
        "id": "measure",
        "type": "dataset_loop",
        "iterations_per_item": 3,
        "record_metrics": True,
        "order": "sequential",
        "cooldown_ms": 100,
        "stop_on_error": False
    },
    operation_spec=operation_spec,
    model_profile=model_profile,
    runtime_parameters=runtime_parameters,
    dataset=dataset,
    headers=headers
)
```

## Position dans le pipeline

```text
resolve_operation_spec()
→ prepare_dataset()
→ build_request_payload()
→ execute_test_stage()
    → execute_http_request()
→ normalise_response()
→ compute_metrics()
→ aggregate_metrics()
```

---

# Fonction 7 — `compute_metrics()`

## Rôle

Calculer les métriques unitaires à partir d’une réponse normalisée.

Cette fonction répond à la question :

```text
Quelles métriques peut-on extraire de cette exécution unitaire ?
```

Elle transforme une réponse normalisée en un ensemble stable de métriques exploitables.

## Signature proposée

```python
def compute_metrics(
    metrics_spec: list[str],
    normalized_response: dict,
    dataset_item: dict | None = None
) -> dict:
```

## Paramètres d’entrée

### `metrics_spec: list[str]`

Liste des métriques demandées par le template.

Exemple :

```python
[
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "elapsed_ms",
    "tokens_per_second",
    "output_input_token_ratio"
]
```

### `normalized_response: dict`

Réponse normalisée produite par `normalise_response()`.

Champs typiquement utilisés :

```text
content
input_tokens
output_tokens
total_tokens
elapsed_ms
tool_calls
finish_reason
error
```

### `dataset_item: dict | None`

Item dataset optionnel.

Utile pour les métriques évaluatives :

```text
expected_answer
expected_tool_calls
expected_format
expected_schema
evaluation
```

## Sortie

La fonction retourne un dictionnaire de métriques calculées.

```python
{
    "input_tokens": 42,
    "output_tokens": 128,
    "total_tokens": 170,
    "elapsed_ms": 1240.52,
    "tokens_per_second": 103.18,
    "output_input_token_ratio": 3.05
}
```

## Familles de métriques

### Tokens

```text
input_tokens
output_tokens
total_tokens
```

### Temps

```text
elapsed_ms
first_token_ms
```

`first_token_ms` pourra être ajouté plus tard pour les réponses streamées.

Les stages pairés peuvent produire des métriques dérivées nommées par le
template. Ces métriques ne sont pas des métriques intégrées globales : elles sont
déclarées dans `stage_spec.derived_metrics` et calculées à partir de plusieurs
réponses d'une même itération.

Exemple pour un test de cold start :

```text
cold_total_ms
→ elapsed_ms du membre de paire `cold`

hot_total_ms
→ elapsed_ms du membre de paire `hot`

cold_penalty_ms
→ cold_total_ms - hot_total_ms
```

La forme générique recommandée pour les métriques de paire est :

```text
pair.<pair_member_id>.<metric_name>
```

Exemple :

```text
pair.cold.elapsed_ms
pair.hot.elapsed_ms
```

### Débit

```text
tokens_per_second
decode_tokens_per_second
prefill_tokens_per_second
```

Formule (débit bout-en-bout, prefill inclus) :

```text
output_tokens / (elapsed_ms / 1000)
```

`decode_tokens_per_second` isole la phase de décodage du prefill en utilisant
`first_token_ms` (disponible uniquement en streaming). Vaut `null` si
`first_token_ms` est absent ou si la fenêtre de décodage est nulle :

```text
output_tokens / ((elapsed_ms - first_token_ms) / 1000)
```

`prefill_tokens_per_second` mesure la vitesse de traitement du prompt. Vaut `null`
si `first_token_ms` est absent ou nul :

```text
input_tokens / (first_token_ms / 1000)
```

### Ratios

```text
output_input_token_ratio
```

Formule :

```text
output_tokens / input_tokens
```

### Tool calling

```text
tool_call_count
tool_selected_correctly
tool_arguments_valid
tool_call_assertion_pass
missing_tool_call
hallucinated_tool_call
```

`tool_call_assertion_pass` est la métrique booléenne synthétique pour les tests
single-turn de tool calling. Elle vaut `true` uniquement si les appels d’outils
normalisés correspondent exactement à `expected_tool_calls` : bons noms d’outils,
nombre d’appels exact, aucun appel inattendu, aucun appel manquant, et arguments
égaux structurellement. Elle vaut `null` si `expected_tool_calls` n’est pas
défini. Pour `expected_tool_calls: []`, elle vaut `true` uniquement si le modèle
n’émet aucun appel d’outil.

Pour les items `interaction_mode = agentic` avec `tool_result`, les métriques de
tool calling sont évaluées sur la première réponse assistant. Les métriques de
réponse (`exact_match`, `contains_required_terms`, `regex_match`, `json_valid`,
`schema_valid`) sont évaluées sur la réponse directe lorsque aucun outil n’est
attendu, ou sur la réponse finale produite après injection du résultat d’outil
statique lorsqu’un outil est attendu. Le runner s’arrête au premier échec de
gate, marque les items suivants comme `skipped`, et conserve le transcript final
dans `extensions.agentic`. Les échecs restent des résultats qualité et ne
transforment pas à eux seuls le run en erreur d’exécution.

### Structured output

```text
json_valid
schema_valid
regex_match
```

### Exact match / conformité

```text
exact_match
contains_required_terms
```

## Gestion des métriques impossibles à calculer

Si une métrique ne peut pas être calculée :

```text
- valeur manquante
- provider ne retourne pas les tokens
- division impossible
```

alors :

```python
metric_value = None
```

sans lever d’erreur bloquante.

## Métriques dérivées

Certaines métriques dépendent d’autres métriques.

Exemple :

```text
tokens_per_second
→ nécessite output_tokens + elapsed_ms
```

La fonction doit calculer automatiquement les dépendances internes nécessaires.

Les stages pairés ajoutent une seconde famille de métriques dérivées : les
métriques calculées à partir de plusieurs réponses appartenant à une même
itération. Le nom de ces métriques est défini par le template.

Exemple :

```json
{
  "id": "cold_penalty_ms",
  "type": "difference",
  "left": "cold.elapsed_ms",
  "right": "hot.elapsed_ms",
  "unit": "ms"
}
```

Résultat :

```python
{
    "cold_total_ms": 1800.0,
    "hot_total_ms": 650.0,
    "cold_penalty_ms": 1150.0
}
```

Ces métriques doivent être calculées après l'exécution complète d'une paire,
mais avant l'agrégation globale. `cold_penalty_ms` est un exemple ; un autre
template pourrait déclarer `prompt_variant_delta_ms`, `cache_saving_ms` ou tout
autre identifiant métier.

## Évaluation simple

Si `dataset_item.evaluation` est présent, la fonction peut appliquer une logique évaluative simple.

Exemple :

```json
{
  "type": "exact_match",
  "case_sensitive": false
}
```

Résultat :

```python
{
    "exact_match": True
}
```

## Erreurs attendues

La fonction doit signaler explicitement :

```text
- métrique inconnue
- normalized_response invalide
- formule impossible
- division par zéro
- expected_schema invalide
```

Mais elle doit rester permissive autant que possible.

## Décisions de conception

Cette fonction ne doit pas :

```text
- appeler le serveur HTTP
- charger le dataset
- agréger les résultats globaux
- gérer les itérations
```

Elle doit uniquement calculer des métriques unitaires.

## Exemple d’utilisation

```python
metrics = compute_metrics(
    metrics_spec=[
        "input_tokens",
        "output_tokens",
        "elapsed_ms",
        "tokens_per_second"
    ],
    normalized_response=normalized_response,
    dataset_item=dataset_item
)
```

---

# Fonction 8 — `aggregate_metrics()`

## Rôle

Calculer les statistiques agrégées finales à partir des métriques unitaires produites pendant les stages.

Cette fonction répond à la question :

```text
Quels sont les résultats globaux du benchmark ?
```

Elle produit les statistiques finales utilisées pour le reporting et la comparaison des modèles.

## Signature proposée

```python
def aggregate_metrics(
    metric_results: list[dict],
    aggregation_spec: list[str]
) -> dict:
```

## Paramètres d’entrée

### `metric_results: list[dict]`

Liste des métriques unitaires.

Exemple :

```python
[
    {
        "input_tokens": 42,
        "output_tokens": 128,
        "elapsed_ms": 1240.52
    },
    {
        "input_tokens": 38,
        "output_tokens": 101,
        "elapsed_ms": 1101.17
    }
]
```

### `aggregation_spec: list[str]`

Liste des agrégations à produire.

Exemple :

```python
[
    "mean",
    "median",
    "min",
    "max",
    "p95",
    "stddev"
]
```

## Sortie

La fonction retourne un dictionnaire agrégé.

```python
{
    "elapsed_ms": {
        "mean": 1170.84,
        "median": 1170.84,
        "min": 1101.17,
        "max": 1240.52,
        "p95": 1233.55,
        "stddev": 69.67
    },

    "output_tokens": {
        "mean": 114.5,
        "median": 114.5,
        "min": 101,
        "max": 128
    }
}
```

## Agrégations supportées

Valeurs proposées :

```text
mean
median
min
max
sum
count
p50
p90
p95
p99
stddev
variance
```

## Gestion des valeurs nulles

Les valeurs :

```text
None
NaN
```

ne doivent pas casser les agrégations.

Recommandation :

```text
- ignorer les valeurs nulles
- conserver un compteur de valeurs valides
```

## Agrégations par métrique

Chaque métrique numérique doit être agrégée indépendamment.

Exemple :

```text
elapsed_ms
→ mean, median, p95

output_tokens
→ mean, max
```

Pour un stage `paired_request_loop`, les métriques dérivées doivent être
agrégées comme les métriques numériques ordinaires.

Exemple :

```text
<derived_metric_id>
→ median, mean, p95

pair.<baseline>.elapsed_ms
→ median, mean, p95

pair.<comparison>.elapsed_ms
→ median, mean, p95
```

Exemple de sortie pour un test de cold start :

```python
{
    "cold_penalty_ms": {
        "median": 1150.0,
        "mean": 1175.4,
        "p95": 1620.8,
        "count": 5
    },
    "cold_total_ms": {
        "median": 1800.0,
        "mean": 1812.3,
        "p95": 2240.1,
        "count": 5
    },
    "hot_total_ms": {
        "median": 650.0,
        "mean": 636.9,
        "p95": 710.4,
        "count": 5
    }
}
```

Les métriques booléennes peuvent être transformées en ratios.

Exemple :

```text
exact_match
→ success_rate
```

## Métriques de succès

La fonction peut produire automatiquement :

```text
success_count
failure_count
success_rate
```

à partir du champ :

```text
ok
```

## Groupements futurs

Le design doit permettre plus tard :

```text
- agrégation par tag
- agrégation par dataset item
- agrégation par stage
- agrégation par interaction_mode
```

Mais cela ne doit pas être implémenté immédiatement.

## Erreurs attendues

La fonction doit signaler explicitement :

```text
- aggregation inconnue
- métrique non numérique pour agrégation numérique
- liste vide
```

## Décisions de conception

Cette fonction ne doit pas :

```text
- exécuter les requêtes HTTP
- normaliser les réponses
- calculer les métriques unitaires
- connaître les providers
```

Elle doit uniquement produire des statistiques globales.

## Exemple d’utilisation

```python
aggregated = aggregate_metrics(
    metric_results=metric_results,
    aggregation_spec=[
        "mean",
        "median",
        "p95",
        "stddev"
    ]
)
```

## Position finale du pipeline moteur

```text
instantiate_test()
→ TestInstantiation
→ run_test_instantiation()
    → execute_test_stage()
        → build_request_payload()
        → execute_http_request()
        → normalise_response()
        → compute_metrics()
    → aggregate_metrics()
→ TestRunResult
```

---

# Persistence strategy for `TestRunResult`

## Objectif

Garantir qu’aucun résultat d’exécution ne soit perdu ou rendu inexploitable à cause :

```text
- d’une évolution du moteur
- d’une évolution du schéma
- d’une interruption
- d’une annulation utilisateur
- d’un crash process
- d’une erreur serveur
```

Un résultat de benchmark doit rester lisible, auditable et interprétable même si le code ou les schémas évoluent.

## Principe fondamental

```text
Un résultat ne doit jamais dépendre du schéma courant pour rester compréhensible.
```

Chaque `TestRunResult` doit donc embarquer suffisamment d’informations pour être compris de manière autonome.

## Stratégie recommandée

Utiliser une stratégie append-only.

Règles :

```text
- ne jamais modifier destructivement un TestRunResult existant
- ne jamais recalculer silencieusement des métriques historiques
- une nouvelle exécution produit toujours un nouveau run_id
- une nouvelle version de métrique produit un nouveau champ ou une nouvelle version
- les réponses brutes doivent être conservées
- les réponses normalisées doivent être conservées
- les erreurs et warnings doivent être conservés
```

## Données à persister

Chaque `TestRunResult` doit contenir au minimum :

```text
schema_version
engine_version
run_id
instantiation_id
status
started_at
completed_at
instantiation_snapshot
stage_results
raw_responses
normalized_responses
metric_results
aggregated_metrics
errors
warnings
```

## Exemple de structure

```json
{
  "kind": "test_run_result",
  "schema_version": "benchmark_test_run_result_v1",
  "engine_version": "0.3.0",
  "run_id": "run_20260515_001",
  "instantiation_id": "test_20260515_001",
  "status": "completed_with_errors",
  "started_at": "2026-05-15T18:10:00Z",
  "completed_at": "2026-05-15T18:35:00Z",

  "instantiation_snapshot": {},

  "stage_results": [],
  "raw_responses": [],
  "normalized_responses": [],
  "metric_results": [],
  "aggregated_metrics": {},

  "errors": [],
  "warnings": []
}
```

## Statuts du run

Valeurs recommandées :

```text
created
running
completed
completed_with_errors
cancelled
failed
timeout
```

## Statuts unitaires

Chaque exécution élémentaire doit également porter son propre statut.

Valeurs recommandées :

```text
pending
running
completed
failed
retried
cancelled
skipped
```

## Persistance des résultats partiels

Les résultats partiels doivent être persistés en cas :

```text
- d’annulation utilisateur
- de timeout global
- d’échec partiel
- de crash récupérable
- d’arrêt contrôlé du moteur
```

Raison :

```text
Ne jamais perdre de données d’exécution utiles au diagnostic, à l’audit ou à une reprise ultérieure.
```

Attention :

```text
persisted partial result ≠ successful benchmark
```

Le statut du run doit indiquer clairement que l’exécution est partielle ou annulée.

## Agrégations sur résultats partiels

Si des agrégations sont calculées malgré des résultats partiels, elles doivent exposer :

```text
valid_sample_count
expected_sample_count
missing_sample_count
partial_execution
```

Exemple :

```json
{
  "elapsed_ms": {
    "mean": 1220.4,
    "p95": 1801.7,
    "valid_sample_count": 84,
    "expected_sample_count": 100,
    "missing_sample_count": 16,
    "partial_execution": true
  }
}
```

## Conservation des données brutes

Le système doit conserver :

```text
- la réponse brute provider
- la réponse normalisée
- les métriques calculées
- les erreurs techniques
```

Cela permet :

```text
- de recalculer des métriques avec un nouveau moteur si nécessaire
- de diagnostiquer les erreurs provider-specific
- de comparer les normalisations entre versions
```

## Versioning

Chaque résultat doit inclure :

```text
schema_version
engine_version
metric_version si nécessaire
normalizer_version si nécessaire
```

Objectif : permettre la lecture et l’interprétation d’anciens résultats sans ambiguïté.

## Redaction et données sensibles

Avant persistance, les données sensibles doivent être masquées :

```text
Authorization
API-Key
X-API-Key
Cookie
secrets dans headers
```

La redaction ne doit pas supprimer les informations nécessaires au diagnostic, mais elle doit empêcher la fuite de secrets.

---

# Retry and cancellation policy

## Objectif

Définir comment le moteur doit réagir face aux erreurs temporaires, aux timeouts, aux annulations utilisateur et aux interruptions contrôlées.

Cette politique doit éviter deux écueils :

```text
- arrêter prématurément un benchmark à cause d’une erreur temporaire
- continuer indéfiniment malgré des erreurs structurelles
```

## Localisation dans le modèle

La politique doit être portée par `TestInstantiation`, dans une section :

```json
{
  "execution_policy": {}
}
```

Cette politique fait partie du snapshot figé.

## Exemple recommandé

```json
{
  "execution_policy": {
    "timeout_ms": 300000,

    "retry_policy": {
      "max_retries": 2,
      "retry_on": [
        "timeout",
        "connection_error",
        "http_429",
        "http_503"
      ],
      "backoff": "exponential",
      "base_delay_ms": 1000,
      "max_delay_ms": 10000
    },

    "cancellation_policy": {
      "cancel_on_first_fatal_error": false,
      "max_error_rate": 0.2,
      "max_consecutive_errors": 5,
      "graceful_shutdown": true,
      "persist_partial_results": true
    }
  }
}
```

## Retry policy

### `max_retries`

Nombre maximal de tentatives supplémentaires après l’échec initial.

Exemple :

```text
max_retries = 2
→ 1 tentative initiale + 2 retries maximum
```

### `retry_on`

Liste des erreurs considérées comme transitoires.

Valeurs recommandées :

```text
timeout
connection_error
http_408
http_429
http_500
http_502
http_503
http_504
```

### `backoff`

Stratégie d’attente entre deux tentatives.

Valeurs proposées :

```text
none
fixed
linear
exponential
```

### `base_delay_ms` et `max_delay_ms`

Contrôlent la durée d’attente entre deux retries.

## Erreurs non retryables

Certaines erreurs doivent être considérées comme structurelles.

Exemples :

```text
invalid_payload
unsupported_operation
unsupported_parameter
invalid_dataset_item
schema_validation_error
http_400
http_401
http_403
http_404
```

Ces erreurs ne doivent pas être rejouées automatiquement sauf configuration explicite.

## Cancellation policy

### `cancel_on_first_fatal_error`

Si `true`, le stage ou le run s’arrête dès la première erreur fatale.

### `max_error_rate`

Taux d’erreur maximal toléré avant annulation.

Exemple :

```text
0.2 → annulation si plus de 20 % des exécutions échouent
```

### `max_consecutive_errors`

Nombre maximal d’erreurs consécutives avant arrêt.

Utile pour détecter :

```text
- serveur arrêté
- provider inaccessible
- modèle non chargé
- payload systématiquement invalide
```

### `graceful_shutdown`

Si `true`, le moteur doit :

```text
- arrêter de créer de nouvelles requêtes
- laisser finir les requêtes en cours si possible
- persister les résultats déjà obtenus
- marquer les requêtes non exécutées comme skipped ou cancelled
```

### `persist_partial_results`

Si `true`, tous les résultats déjà collectés doivent être persistés même si le run est annulé ou échoue.

Valeur recommandée :

```text
true
```

## Impact sur `execute_test_stage()`

`execute_test_stage()` doit :

```text
- appliquer la retry_policy sur chaque requête unitaire
- suivre le nombre d’erreurs consécutives
- suivre le taux d’erreur du stage
- respecter stop_on_error si défini au niveau stage
- retourner les statuts unitaires
```

## Impact sur `run_test_instantiation()`

`run_test_instantiation()` doit :

```text
- initialiser le TestRunResult dès le démarrage
- persister régulièrement l’état du run
- appliquer la cancellation_policy globale
- marquer correctement le statut final
- déclencher aggregate_metrics() uniquement sur les résultats valides
```

## Statut final attendu

Le statut final doit refléter fidèlement l’exécution.

Exemples :

```text
completed
completed_with_errors
cancelled
failed
timeout
```

## Principe de sûreté

```text
Toute exécution commencée doit produire un artefact persistant, même si elle échoue.
```

C’est une exigence centrale pour un outil de benchmark fiable.


---

# Couche orchestration — `BenchmarkPlan`

## Rôle

Un `BenchmarkPlan` permet d’exécuter automatiquement un même benchmark logique sur plusieurs modèles, datasets ou profils runtime.

Il ne remplace pas `TestInstantiation`.

Il produit plusieurs `TestInstantiation`.

## Exemple

```json
{
  "kind": "benchmark_plan",
  "schema_version": "benchmark_plan_v1",
  "plan_id": "compare_models_verbosity_v1",
  "template_ref": "verbosity_ratio_v1",
  "dataset_ref": "verbosity_prompts_v1",
  "runtime_profile_ref": "deterministic_generation_v1",
  "model_profile_refs": [
    "ollama_qwen25_7b",
    "ollama_mistral_7b",
    "lmstudio_llama31_8b"
  ],
  "execution": {
    "mode": "sequential",
    "continue_on_model_error": true
  }
}
```

## Fonction d’orchestration — `run_benchmark_plan()`

### Rôle

Exécuter un plan multi-modèles ou multi-configurations en s’appuyant sur le moteur d’exécution unitaire.

### Signature proposée

```python
def run_benchmark_plan(
    benchmark_plan: dict
) -> dict:
```

### Comportement attendu

La fonction doit :

```text
1. Résoudre les références du plan
2. Construire N TestInstantiations
3. Persister chaque TestInstantiation
4. Exécuter chaque TestInstantiation via run_test_instantiation()
5. Collecter les TestRunResults
6. Produire un résultat comparatif global
```

## Résultat attendu

```json
{
  "kind": "benchmark_plan_result",
  "plan_id": "compare_models_verbosity_v1",
  "run_results": [
    {
      "model_profile_ref": "ollama_qwen25_7b",
      "instantiation_id": "test_001",
      "run_id": "run_001",
      "status": "completed"
    }
  ],
  "comparison": {}
}
```

## Décision de conception

`run_benchmark_plan()` ne doit pas être dans le core engine.

Il doit appartenir à une couche séparée, par exemple :

```text
orchestrators/benchmark_plan_runner.py
```

Le core engine reste responsable d’une seule unité :

```text
1 TestInstantiation
→ 1 TestRunResult
```


---

# Fonction 6 — `normalise_response()`

## Rôle

Transformer une réponse provider-specific brute en une représentation interne stable et exploitable par le reste du pipeline.

Cette fonction répond à la question :

```text
Quelle est la réponse métier du modèle, indépendamment du provider utilisé ?
```

Elle permet d’éviter que les métriques, évaluateurs et agrégateurs connaissent les formats spécifiques Ollama, OpenAI-compatible ou autres.

## Signature proposée

```python
def normalise_response(
    operation_spec: dict,
    http_result: dict
) -> dict:
```

## Paramètres d’entrée

### `operation_spec: dict`

Résultat de `resolve_operation_spec()`.

Champs utilisés :

```text
protocol
operation
```

Exemple :

```json
{
  "method": "POST",
  "url": "http://localhost:11434/api/chat",
  "endpoint": "/api/chat",
  "protocol": "ollama_chat",
  "operation": "chat_completion"
}
```

### `http_result: dict`

Résultat brut produit par `execute_http_request()`.

Exemple :

```json
{
  "ok": true,
  "status_code": 200,
  "headers": {},
  "raw_response": {
    "message": {
      "role": "assistant",
      "content": "RAG combines retrieval and generation."
    },
    "done": true,
    "eval_count": 128,
    "prompt_eval_count": 42
  },
  "text_response": null,
  "elapsed_ms": 1240.52,
  "error": null
}
```

## Sortie

La fonction retourne une réponse normalisée.

```python
{
    "ok": True,
    "runtime_schema_family": "ollama",
    "protocol": "ollama_chat",
    "operation": "chat_completion",

    "content": "RAG combines retrieval and generation.",

    "messages": [
        {
            "role": "assistant",
            "content": "RAG combines retrieval and generation."
        }
    ],

    "tool_calls": [],
    "turn_index": 0,
    "turn_type": "final_answer",

    "input_tokens": 42,
    "output_tokens": 128,
    "total_tokens": 170,

    "finish_reason": "stop",

    "elapsed_ms": 1240.52,

    "status_code": 200,

    "raw_response": {},

    "error": None
}
```

## Objectif principal

La sortie doit être stable quel que soit le provider.

Les couches suivantes doivent pouvoir consommer :

```text
content
messages
tool_calls
turn_index
turn_type
input_tokens
output_tokens
total_tokens
finish_reason
elapsed_ms
```

sans connaître le format du provider source.

## Champs normalisés proposés

### `ok`

Booléen indiquant si la requête a abouti techniquement.

### `runtime_schema_family`

Famille de schema API utilisée par le runtime, distincte de `identity.provider` qui désigne le fournisseur LLM/base model.

Exemple :

```text
ollama
openai-compatible
lmstudio
```

### `protocol`

Nom du protocole interne.

Exemple :

```text
ollama_chat
openai_chat
ollama_embedding
```

### `operation`

Nom logique de l’opération.

Exemple :

```text
chat_completion
embedding
list_models
```

### `content`

Contenu texte principal produit par le modèle.

Pour une chat completion standard :

```text
assistant message content
```

Pour une embedding request :

```text
None
```

### `messages`

Liste normalisée des messages retournés.

Exemple :

```json
[
  {
    "role": "assistant",
    "content": "RAG combines retrieval and generation."
  }
]
```

### `tool_calls`

Liste normalisée des appels d’outils.

Format proposé :

```json
[
  {
    "tool": "get_weather",
    "arguments": {
      "city": "Paris"
    }
  }
]
```

Valeur par défaut :

```json
[]
```

### `input_tokens`

Nombre de tokens en entrée.

Peut être :

```text
None
```

si le provider ne retourne pas cette information.

### `output_tokens`

Nombre de tokens générés.

### `total_tokens`

Somme :

```text
input_tokens + output_tokens
```

si les deux sont disponibles.

Sinon :

```text
None
```

### `finish_reason`

Raison d’arrêt de génération.

Valeurs possibles :

```text
stop
length
tool_calls
error
unknown
```

### `elapsed_ms`

Temps total de requête récupéré depuis `execute_http_request()`.

### `status_code`

Status code HTTP.

### `raw_response`

Réponse brute originale conservée pour audit et debug.

### `error`

Erreur technique normalisée.

Exemple :

```json
{
  "type": "HTTPError",
  "message": "HTTP 500 returned by inference server"
}
```

## Exemple de normalisation — Ollama chat

Entrée :

```json
{
  "message": {
    "role": "assistant",
    "content": "RAG combines retrieval and generation."
  },
  "done": true,
  "eval_count": 128,
  "prompt_eval_count": 42
}
```

Sortie :

```json
{
  "content": "RAG combines retrieval and generation.",
  "messages": [
    {
      "role": "assistant",
      "content": "RAG combines retrieval and generation."
    }
  ],
  "input_tokens": 42,
  "output_tokens": 128,
  "total_tokens": 170,
  "tool_calls": [],
  "finish_reason": "stop"
}
```

## Exemple de normalisation — OpenAI-compatible

Entrée :

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "RAG combines retrieval and generation."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 128,
    "total_tokens": 170
  }
}
```

Sortie :

```json
{
  "content": "RAG combines retrieval and generation.",
  "messages": [
    {
      "role": "assistant",
      "content": "RAG combines retrieval and generation."
    }
  ],
  "input_tokens": 42,
  "output_tokens": 128,
  "total_tokens": 170,
  "tool_calls": [],
  "finish_reason": "stop"
}
```

## Support du tool calling

Si la réponse contient des appels d’outils provider-specific, la fonction doit les convertir vers un format interne stable.

Exemple cible :

```json
[
  {
    "tool": "get_weather",
    "arguments": {
      "city": "Paris"
    }
  }
]
```

## Support des embeddings

Pour une opération `embedding` :

```text
content         → None
messages        → []
input_tokens    → selon provider
embedding       → vecteur float
```

Le format normalisé pourra être étendu avec :

```python
"embedding": [0.123, 0.456, ...]
```

## Gestion des réponses incomplètes

La fonction doit tolérer :

```text
- absence de tokens usage
- absence de finish_reason
- absence de messages
- réponses texte brutes
```

Dans ces cas :

```text
- utiliser None
- utiliser []
- utiliser unknown
```

sans lever d’erreur bloquante.

## Erreurs attendues

La fonction doit signaler explicitement :

```text
- protocol inconnu
- raw_response absent
- format provider invalide
- structure de réponse inattendue
```

Mais elle doit rester permissive autant que possible afin de conserver les données brutes pour debug.

## Décisions de conception

Cette fonction ne doit pas :

```text
- exécuter la requête HTTP
- construire le payload
- charger le dataset
- calculer les métriques métier
- agréger les résultats
- appliquer les règles d’évaluation
```

Elle doit uniquement convertir la réponse provider-specific vers un format interne stable.

## Exemple d’utilisation

```python
normalized = normalise_response(
    operation_spec=operation_spec,
    http_result=http_result
)
```

## Position dans le pipeline

```text
resolve_operation_spec()
→ prepare_dataset()
→ build_request_payload()
→ execute_test_stage()
    → execute_http_request()
→ normalise_response()
→ compute_metrics()
→ aggregate_metrics()
```


---

# Fonction 5 — `execute_http_request()`

## Rôle

Exécuter une requête HTTP unitaire vers le serveur d’inférence et retourner un résultat brut normalisé.

Cette fonction répond à la question :

```text
Quel est le résultat technique d’un appel HTTP donné ?
```

Elle est volontairement bas niveau. Elle ne connaît pas les notions de test, stage, dataset, métriques métier ou évaluation.

## Signature proposée

```python
def execute_http_request(
    operation_spec: dict,
    payload: dict | None = None,
    headers: dict | None = None,
    timeout_ms: int | None = None
) -> dict:
```

## Paramètres d’entrée

### `operation_spec: dict`

Spécification HTTP produite par `resolve_operation_spec()`.

Champs utilisés :

```text
method
url
protocol
operation
```

Exemple :

```json
{
  "method": "POST",
  "url": "http://localhost:11434/api/chat",
  "endpoint": "/api/chat",
  "protocol": "ollama_chat",
  "operation": "chat_completion"
}
```

### `payload: dict | None`

Body JSON à envoyer.

Il est généralement produit par `build_request_payload()`.

Pour les méthodes `GET`, il peut être `None`.

### `headers: dict | None`

Headers HTTP optionnels.

Exemple :

```json
{
  "Authorization": "Bearer xxx",
  "Content-Type": "application/json"
}
```

Si `Content-Type` est absent pour une requête avec payload, la fonction peut ajouter par défaut :

```text
Content-Type: application/json
```

### `timeout_ms: int | None`

Timeout de la requête en millisecondes.

Si absent, une valeur par défaut peut être utilisée, par exemple :

```text
300000 ms
```

## Sortie

La fonction retourne un dictionnaire normalisé.

```python
{
    "ok": True,
    "status_code": 200,
    "headers": {},
    "raw_response": {},
    "text_response": None,
    "elapsed_ms": 1240.52,
    "error": None
}
```

En cas d’erreur :

```python
{
    "ok": False,
    "status_code": None,
    "headers": {},
    "raw_response": None,
    "text_response": None,
    "elapsed_ms": 300000.0,
    "error": {
        "type": "TimeoutError",
        "message": "Request timed out after 300000 ms"
    }
}
```

## Mesure du temps

La fonction doit mesurer le temps total de la requête HTTP avec une horloge monotone.

Recommandation d'implémentation :

```python
start = time.perf_counter()
...
elapsed_ms = (time.perf_counter() - start) * 1000
```

En TypeScript, l'équivalent peut utiliser `performance.now()`. La contrainte
normative est l'usage d'une horloge monotone, pas l'API exacte.

Ce temps correspond à la latence totale côté client :

```text
avant envoi requête → réception complète de la réponse
```

Pour le streaming et le first-token latency, une fonction spécialisée pourra être ajoutée plus tard ou cette fonction pourra évoluer avec un mode `stream=True`.

## Comportement attendu

La fonction doit :

```text
1. Lire method et url depuis operation_spec
2. Préparer les headers
3. Envoyer la requête HTTP
4. Mesurer elapsed_ms
5. Tenter de parser la réponse en JSON
6. Si parsing JSON impossible, conserver text_response
7. Retourner un résultat normalisé
8. Capturer les erreurs sans faire échouer brutalement tout le stage
```

## Gestion des méthodes HTTP

Méthodes supportées initialement :

```text
GET
POST
```

Comportement :

```text
GET  → pas de payload JSON obligatoire
POST → payload JSON attendu sauf exception documentée
```

## Parsing de réponse

Si la réponse est du JSON valide :

```python
raw_response = response.json()
text_response = None
```

Si la réponse n’est pas du JSON valide :

```python
raw_response = None
text_response = response.text
```

Cela permet de diagnostiquer correctement les erreurs HTML, texte brut ou réponses provider non conformes.

## Gestion des erreurs HTTP

Un status code HTTP non-2xx ne doit pas nécessairement lever une exception non capturée.

Recommandation : retourner :

```python
{
    "ok": False,
    "status_code": 500,
    "raw_response": {...},
    "error": {
        "type": "HTTPError",
        "message": "HTTP 500 returned by inference server"
    }
}
```

Le choix d’arrêter ou continuer le stage appartient à `execute_test_stage()` via `stop_on_error`.

## Erreurs attendues

La fonction doit capturer ou signaler explicitement :

```text
- method manquant
- url manquante
- méthode HTTP non supportée
- timeout
- connection error
- DNS error
- refused connection
- invalid URL
- JSON parsing failure, sans considérer cela comme erreur HTTP bloquante
- HTTP status code non-2xx
```

## Données sensibles

La fonction ne doit pas logger directement les headers complets si ceux-ci contiennent :

```text
Authorization
API-Key
X-API-Key
Cookie
```

La redaction doit être appliquée avant tout log ou export de debug.

## Décisions de conception

Cette fonction ne doit pas :

```text
- construire le payload
- gérer les itérations
- gérer le dataset
- interpréter la réponse modèle
- calculer les tokens
- calculer les métriques métier
- appliquer les règles d’évaluation
```

Elle doit uniquement exécuter un appel HTTP unitaire et retourner une trace technique fiable.

## Exemple d’utilisation

```python
http_result = execute_http_request(
    operation_spec={
        "method": "POST",
        "url": "http://localhost:11434/api/chat",
        "protocol": "ollama_chat",
        "operation": "chat_completion"
    },
    payload={
        "model": "qwen2.5:7b-instruct-q4_K_M",
        "messages": [
            {"role": "user", "content": "Explain RAG in simple terms."}
        ],
        "stream": False
    },
    headers={"Content-Type": "application/json"},
    timeout_ms=300000
)
```

## Position dans le pipeline

```text
resolve_operation_spec()
→ prepare_dataset()
→ build_request_payload()
→ execute_test_stage()
    → execute_http_request()
→ normalise_response()
→ compute_metrics()
→ aggregate_metrics()
```
