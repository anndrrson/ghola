-- Native foundation model catalog. Curated metadata, not proxied from HuggingFace.
-- All rows owned by the platform user. Together.ai-backed entries chat immediately via
-- the existing fallback in chat.rs. Catalog-only entries (provider_model_id NULL)
-- surface a "notify me when available" waitlist on the detail page.
--
-- License note: Llama community license technically requires acceptance for commercial
-- use over the threshold. Phase 3 will add a click-through gate; for now we surface
-- license + license_url on the detail page and trust users.

-- ── Update existing 4 platform rows with foundation metadata + tiered pricing ──

UPDATE models SET
    is_foundation = TRUE,
    developer = 'Meta',
    architecture = 'llama',
    params_b = 8.03,
    context_window = 131072,
    license = 'llama-3.1-community',
    license_url = 'https://www.llama.com/llama3_1/license/',
    hf_id = 'meta-llama/Llama-3.1-8B-Instruct',
    release_date = '2024-07-23',
    gguf_available = TRUE,
    recommended_vram_gb = 8,
    price_per_query = 0,
    free_queries_per_day = 10
WHERE slug = 'llama-3-8b';

UPDATE models SET
    is_foundation = TRUE,
    developer = 'Alibaba',
    architecture = 'qwen3',
    params_b = 32.5,
    context_window = 131072,
    license = 'apache-2.0',
    license_url = 'https://www.apache.org/licenses/LICENSE-2.0',
    hf_id = 'Qwen/Qwen3-32B',
    release_date = '2025-04-29',
    gguf_available = TRUE,
    recommended_vram_gb = 32
WHERE slug = 'qwen-32b';

UPDATE models SET
    is_foundation = TRUE,
    developer = 'Meta',
    architecture = 'llama',
    params_b = 70.6,
    context_window = 131072,
    license = 'llama-3.3-community',
    license_url = 'https://www.llama.com/llama3_3/license/',
    hf_id = 'meta-llama/Llama-3.3-70B-Instruct',
    release_date = '2024-12-06',
    gguf_available = TRUE,
    recommended_vram_gb = 48
WHERE slug = 'llama-3-70b';

UPDATE models SET
    is_foundation = TRUE,
    developer = 'Meta',
    architecture = 'llama-4-moe',
    params_b = 109,
    active_params_b = 17,
    context_window = 10485760,
    license = 'llama-4-community',
    license_url = 'https://www.llama.com/llama4/license/',
    hf_id = 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    release_date = '2025-04-05',
    gguf_available = FALSE,
    recommended_vram_gb = 80,
    price_per_query = 50000,
    free_queries_per_day = 5
WHERE slug = 'llama-scout-17b';


-- ── Together-backed foundation models (chat works immediately) ──

INSERT INTO models (id, creator_id, slug, name, description, system_prompt,
    base_model, provider_model_id, status, price_per_query, category, tags,
    is_featured, is_platform_model, free_queries_per_day,
    is_foundation, developer, architecture, params_b, active_params_b,
    context_window, license, license_url, hf_id, release_date,
    gguf_available, recommended_vram_gb)
VALUES

-- Llama 4 Maverick 17B 128E (frontier MoE)
('00000000-0000-0000-0000-000000000020',
 '00000000-0000-0000-0000-000000000001',
 'llama-4-maverick-17b',
 'Llama 4 Maverick 17B 128E',
 'Meta''s flagship Llama 4 Mixture-of-Experts. 17B active parameters route through 128 experts (~400B total) for frontier-quality reasoning.',
 'You are a helpful, knowledgeable assistant powered by Llama 4 Maverick. Reason carefully and answer thoroughly.',
 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
 'live', 500000, 'Technology', ARRAY['foundation','meta','llama-4','moe','17b-active'],
 TRUE, TRUE, 1,
 TRUE, 'Meta', 'llama-4-moe', 400, 17,
 1048576, 'llama-4-community', 'https://www.llama.com/llama4/license/',
 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', '2025-04-05',
 FALSE, 200),

-- Qwen 2.5 72B Instruct
('00000000-0000-0000-0000-000000000021',
 '00000000-0000-0000-0000-000000000001',
 'qwen-25-72b',
 'Qwen 2.5 72B Instruct',
 'Alibaba''s high-capability dense model. Strong at multilingual reasoning, math, code, and long-context analysis.',
 'You are a helpful AI assistant powered by Qwen 2.5 72B. Provide clear, well-reasoned responses.',
 'Qwen/Qwen2.5-72B-Instruct-Turbo',
 'Qwen/Qwen2.5-72B-Instruct-Turbo',
 'live', 200000, 'Technology', ARRAY['foundation','alibaba','qwen','72b'],
 TRUE, TRUE, 3,
 TRUE, 'Alibaba', 'qwen2', 72.7, NULL,
 131072, 'qwen', 'https://huggingface.co/Qwen/Qwen2.5-72B-Instruct/blob/main/LICENSE',
 'Qwen/Qwen2.5-72B-Instruct', '2024-09-19',
 TRUE, 48),

-- Qwen 2.5 Coder 32B
('00000000-0000-0000-0000-000000000022',
 '00000000-0000-0000-0000-000000000001',
 'qwen-25-coder-32b',
 'Qwen 2.5 Coder 32B',
 'Specialized coding model from Alibaba. State-of-the-art among open-weight code models — fluent in 90+ languages, strong at refactoring and debugging.',
 'You are a coding assistant powered by Qwen 2.5 Coder. Produce clean, idiomatic, well-tested code. Explain non-obvious choices.',
 'Qwen/Qwen2.5-Coder-32B-Instruct',
 'Qwen/Qwen2.5-Coder-32B-Instruct',
 'live', 50000, 'Technology', ARRAY['foundation','alibaba','qwen','coder','32b'],
 TRUE, TRUE, 5,
 TRUE, 'Alibaba', 'qwen2', 32.8, NULL,
 131072, 'apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0',
 'Qwen/Qwen2.5-Coder-32B-Instruct', '2024-11-12',
 TRUE, 32),

-- DeepSeek V3
('00000000-0000-0000-0000-000000000023',
 '00000000-0000-0000-0000-000000000001',
 'deepseek-v3',
 'DeepSeek V3',
 'DeepSeek''s 671B-parameter MoE with 37B active per token. Frontier-tier open weights for reasoning, math, and code at a fraction of dense-model cost.',
 'You are a thoughtful AI assistant powered by DeepSeek V3. Reason step-by-step on hard problems and answer concisely on easy ones.',
 'deepseek-ai/DeepSeek-V3',
 'deepseek-ai/DeepSeek-V3',
 'live', 500000, 'Technology', ARRAY['foundation','deepseek','moe','671b','37b-active'],
 TRUE, TRUE, 1,
 TRUE, 'DeepSeek', 'deepseek-v3-moe', 671, 37,
 131072, 'deepseek', 'https://github.com/deepseek-ai/DeepSeek-V3/blob/main/LICENSE-MODEL',
 'deepseek-ai/DeepSeek-V3', '2024-12-26',
 TRUE, 512),

-- DeepSeek R1 Distill Llama 70B
('00000000-0000-0000-0000-000000000024',
 '00000000-0000-0000-0000-000000000001',
 'deepseek-r1-distill-70b',
 'DeepSeek R1 Distill Llama 70B',
 'R1''s reasoning capability distilled into a Llama 70B base. Open-weight chain-of-thought reasoning that runs on a single 8×A100 node.',
 'You are a reasoning assistant powered by DeepSeek R1. Think step-by-step inside <think> tags before answering.',
 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
 'live', 200000, 'Technology', ARRAY['foundation','deepseek','reasoning','70b','distill'],
 TRUE, TRUE, 3,
 TRUE, 'DeepSeek', 'llama', 70.6, NULL,
 131072, 'mit', 'https://opensource.org/licenses/MIT',
 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', '2025-01-20',
 TRUE, 48),

-- Mistral Small 3 (24B)
('00000000-0000-0000-0000-000000000025',
 '00000000-0000-0000-0000-000000000001',
 'mistral-small-3',
 'Mistral Small 3 24B',
 'Mistral''s efficient 24B dense model. Competitive with much larger models on reasoning while running fast on a single 32GB GPU.',
 'You are a concise, helpful AI assistant powered by Mistral Small 3. Be direct and accurate.',
 'mistralai/Mistral-Small-24B-Instruct-2501',
 'mistralai/Mistral-Small-24B-Instruct-2501',
 'live', 50000, 'Technology', ARRAY['foundation','mistral','24b','efficient'],
 TRUE, TRUE, 5,
 TRUE, 'Mistral AI', 'llama', 23.6, NULL,
 32768, 'apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0',
 'mistralai/Mistral-Small-24B-Instruct-2501', '2025-01-30',
 TRUE, 24),

-- Gemma 2 27B
('00000000-0000-0000-0000-000000000026',
 '00000000-0000-0000-0000-000000000001',
 'gemma-2-27b',
 'Gemma 2 27B',
 'Google''s open-weight Gemma 2 flagship. Tuned for helpful, safe, balanced responses; strong general-purpose chat under 30B parameters.',
 'You are a helpful AI assistant powered by Gemma 2. Provide balanced, accurate answers.',
 'google/gemma-2-27b-it',
 'google/gemma-2-27b-it',
 'live', 50000, 'Technology', ARRAY['foundation','google','gemma','27b'],
 FALSE, TRUE, 5,
 TRUE, 'Google', 'gemma2', 27.2, NULL,
 8192, 'gemma', 'https://ai.google.dev/gemma/terms',
 'google/gemma-2-27b-it', '2024-06-27',
 TRUE, 24)

ON CONFLICT (id) DO NOTHING;


-- ── Catalog-only foundation models (no provider yet, waitlist via /api/models/:slug/interest) ──
-- price_per_query = 0 because the column is NOT NULL; the frontend recognizes catalog-only
-- entries by provider_model_id IS NULL AND self_hosted_endpoint IS NULL (see awaiting_host
-- in ModelCard) and shows a "Notify me when available" form instead of chat.

INSERT INTO models (id, creator_id, slug, name, description, system_prompt,
    base_model, provider_model_id, status, price_per_query, category, tags,
    is_featured, is_platform_model, free_queries_per_day,
    is_foundation, developer, architecture, params_b, active_params_b,
    context_window, license, license_url, hf_id, release_date,
    gguf_available, recommended_vram_gb)
VALUES

-- DeepSeek R1 671B (full MoE — too costly for platform hosting today)
('00000000-0000-0000-0000-000000000030',
 '00000000-0000-0000-0000-000000000001',
 'deepseek-r1-671b',
 'DeepSeek R1 671B',
 'The full DeepSeek R1 reasoning model — 671B parameters with 37B active. Frontier-grade chain-of-thought reasoning, MIT-licensed open weights. Awaiting node-operator hosting.',
 'You are a reasoning assistant powered by DeepSeek R1. Think step-by-step inside <think> tags before answering.',
 'deepseek-ai/DeepSeek-R1',
 NULL,
 'live', 0, 'Technology', ARRAY['foundation','deepseek','reasoning','moe','671b','37b-active'],
 TRUE, TRUE, 0,
 TRUE, 'DeepSeek', 'deepseek-v3-moe', 671, 37,
 131072, 'mit', 'https://opensource.org/licenses/MIT',
 'deepseek-ai/DeepSeek-R1', '2025-01-20',
 TRUE, 512),

-- Mistral Large 2 (123B; non-commercial license)
('00000000-0000-0000-0000-000000000031',
 '00000000-0000-0000-0000-000000000001',
 'mistral-large-2',
 'Mistral Large 2 123B',
 'Mistral''s research-licensed flagship dense model. 123B parameters, 128K context. Non-commercial license — best suited for research nodes and enterprise hosts with a Mistral commercial agreement.',
 'You are a sophisticated AI assistant powered by Mistral Large 2. Provide thorough, well-reasoned analysis.',
 'mistralai/Mistral-Large-Instruct-2407',
 NULL,
 'live', 0, 'Technology', ARRAY['foundation','mistral','large','123b','non-commercial'],
 FALSE, TRUE, 0,
 TRUE, 'Mistral AI', 'llama', 123, NULL,
 131072, 'mistral-research', 'https://mistral.ai/licenses/MRL-0.1.md',
 'mistralai/Mistral-Large-Instruct-2407', '2024-07-24',
 TRUE, 96),

-- Cohere Command R+ (104B; CC-BY-NC)
('00000000-0000-0000-0000-000000000032',
 '00000000-0000-0000-0000-000000000001',
 'command-r-plus',
 'Command R+ 104B',
 'Cohere''s tool-use and RAG specialist. Best-in-class at structured outputs, citations, and 10-language fluency. CC-BY-NC license — research-grade for non-commercial nodes.',
 'You are an enterprise AI assistant powered by Command R+. Excel at retrieval-augmented answers and tool use; cite sources when available.',
 'CohereForAI/c4ai-command-r-plus-08-2024',
 NULL,
 'live', 0, 'Technology', ARRAY['foundation','cohere','command-r','rag','tool-use','104b'],
 FALSE, TRUE, 0,
 TRUE, 'Cohere', 'command-r', 104, NULL,
 131072, 'cc-by-nc-4.0', 'https://creativecommons.org/licenses/by-nc/4.0/',
 'CohereForAI/c4ai-command-r-plus-08-2024', '2024-08-30',
 TRUE, 80),

-- Nous Hermes 3 405B (community-hosted territory)
('00000000-0000-0000-0000-000000000033',
 '00000000-0000-0000-0000-000000000001',
 'hermes-3-405b',
 'Hermes 3 405B',
 'Nous Research''s flagship fine-tune of Llama 3.1 405B. Steerable, uncensored-by-default agent model with strong roleplay and tool-use behavior. Community-hosted.',
 'You are Hermes, a steerable AI assistant. Follow user instructions precisely; default to direct, unfiltered answers within applicable laws.',
 'NousResearch/Hermes-3-Llama-3.1-405B',
 NULL,
 'live', 0, 'Technology', ARRAY['foundation','nous','hermes','llama','405b','agent'],
 FALSE, TRUE, 0,
 TRUE, 'Nous Research', 'llama', 405, NULL,
 131072, 'llama-3.1-community', 'https://www.llama.com/llama3_1/license/',
 'NousResearch/Hermes-3-Llama-3.1-405B', '2024-08-15',
 TRUE, 320),

-- Microsoft Phi-4 (14B; MIT)
('00000000-0000-0000-0000-000000000034',
 '00000000-0000-0000-0000-000000000001',
 'phi-4',
 'Phi-4 14B',
 'Microsoft''s 14B small-language-model flagship. Punches well above its weight on math and reasoning thanks to synthetic curriculum training. MIT-licensed.',
 'You are a precise, helpful AI assistant powered by Phi-4. Be concise and reason carefully on math and logic.',
 'microsoft/phi-4',
 NULL,
 'live', 0, 'Technology', ARRAY['foundation','microsoft','phi','14b','reasoning'],
 FALSE, TRUE, 0,
 TRUE, 'Microsoft', 'phi', 14.7, NULL,
 16384, 'mit', 'https://opensource.org/licenses/MIT',
 'microsoft/phi-4', '2024-12-12',
 TRUE, 12)

ON CONFLICT (id) DO NOTHING;
