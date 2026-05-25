package xyz.ghola.app.ui

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.ghola.app.R
import xyz.ghola.app.ai.SecureStorage
import xyz.ghola.app.ai.llama.ModelManager
import xyz.ghola.app.email.LocalLlm
import xyz.ghola.app.gmail.GholaMailDatabase
import xyz.ghola.app.ml.VoiceMetric
import xyz.ghola.app.ml.VoicePreference
import kotlin.random.Random

/**
 * v0.6 pitch artifact — the A/B compare panel.
 *
 * For an arbitrary user prompt, generate two emails: one with the base
 * model, one with the LoRA-bound model. Show them side-by-side as
 * "A" and "B" (random which is which to defeat left/right bias). User
 * picks which sounds more like them. Selection logged to
 * [VoicePreference] for future DPO-style fine-tunes + headline stats.
 *
 * Activation path:
 *   1. Settings → long-press "Model:" → "Open voice compare" entry (P11).
 *   2. The post-fine-tune notification deep-linked at `ghola://voice-compare`
 *      (P7 wires this once the optimizer port lands).
 *
 * Honest current state: until P3.2 (the C++ finetune optimizer port)
 * lands, the `voice.lora` file doesn't exist on disk and the LoRA column
 * silently falls back to base. The activity surfaces this honestly via
 * the status text — "No voice LoRA on disk yet" — rather than
 * pretending it's working.
 */
class VoiceCompareActivity : AppCompatActivity() {

    private lateinit var promptInput: EditText
    private lateinit var generateButton: Button
    private lateinit var outputA: TextView
    private lateinit var outputB: TextView
    private lateinit var scoreA: TextView
    private lateinit var scoreB: TextView
    private lateinit var labelA: TextView
    private lateinit var labelB: TextView
    private lateinit var judgmentRow: View
    private lateinit var btnPickA: Button
    private lateinit var btnPickB: Button
    private lateinit var btnTie: Button
    private lateinit var spinner: ProgressBar
    private lateinit var statusText: TextView

    private lateinit var storage: SecureStorage

    /** True if "A" is showing the base model output (false → "A" is LoRA). */
    private var baseOnLeft = true

    /** Captured at generate time so judgment-button handlers can persist. */
    private var currentPrompt: String? = null
    private var currentBase: String? = null
    private var currentLora: String? = null
    private var currentBaseScore: Float? = null
    private var currentLoraScore: Float? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // SECURITY (exported deep-link hardening). This is the only exported
        // BROWSABLE activity (ghola://voice-compare, see AndroidManifest), so
        // any app or web page can launch it. It is treated as PURE NAVIGATION:
        // it must never read data, extras, or the deep-link URI from the launch
        // Intent — every input comes from on-device state (SecureStorage,
        // ModelManager) or the user-typed prompt field. We drop any incoming
        // extras / data here so a future edit can't accidentally start trusting
        // attacker-supplied intent contents.
        intent?.let { launchIntent ->
            launchIntent.replaceExtras(null as Bundle?)
            launchIntent.data = null
        }

        setContentView(R.layout.activity_voice_compare)
        storage = SecureStorage(this)

        promptInput = findViewById(R.id.promptInput)
        generateButton = findViewById(R.id.generateButton)
        outputA = findViewById(R.id.outputA)
        outputB = findViewById(R.id.outputB)
        scoreA = findViewById(R.id.scoreA)
        scoreB = findViewById(R.id.scoreB)
        labelA = findViewById(R.id.labelA)
        labelB = findViewById(R.id.labelB)
        judgmentRow = findViewById(R.id.judgmentRow)
        btnPickA = findViewById(R.id.btnPickA)
        btnPickB = findViewById(R.id.btnPickB)
        btnTie = findViewById(R.id.btnTie)
        spinner = findViewById(R.id.genSpinner)
        statusText = findViewById(R.id.statusText)

        generateButton.setOnClickListener { onGenerateClick() }
        btnPickA.setOnClickListener { onPick(if (baseOnLeft) "BASE" else "LORA") }
        btnPickB.setOnClickListener { onPick(if (baseOnLeft) "LORA" else "BASE") }
        btnTie.setOnClickListener { onPick("TIE") }

        renderInitial()
    }

    private fun renderInitial() {
        val mm = ModelManager(this)
        val message = when {
            !storage.useLlamaCppRuntime() ->
                "Voice compare needs the llama.cpp runtime. Open Settings → long-press 'Model:' → switch runtimes."
            !mm.isModelDownloaded() ->
                "Local model not downloaded yet. Connect to Wi-Fi and re-open Settings."
            !mm.isLoraReady() ->
                "No voice LoRA on disk yet — column B will reuse the base model until you finish a fine-tune."
            else ->
                "Ready. Type a prompt, generate both, pick the one that sounds more like you."
        }
        statusText.text = message
        outputA.text = ""
        outputB.text = ""
        scoreA.text = ""
        scoreB.text = ""
        labelA.text = "› A"
        labelB.text = "› B"
        judgmentRow.visibility = View.GONE
    }

    private fun onGenerateClick() {
        val prompt = promptInput.text?.toString()?.trim().orEmpty()
        if (prompt.isEmpty()) {
            Toast.makeText(this, "Enter a prompt first", Toast.LENGTH_SHORT).show()
            return
        }
        if (!storage.useLlamaCppRuntime()) {
            Toast.makeText(this, "llama.cpp runtime not active — open Settings to enable", Toast.LENGTH_LONG).show()
            return
        }
        val mm = ModelManager(this)
        if (!mm.isModelDownloaded()) {
            Toast.makeText(this, "Local model not present", Toast.LENGTH_LONG).show()
            return
        }

        baseOnLeft = Random.nextBoolean()
        currentPrompt = prompt
        generateButton.isEnabled = false
        spinner.visibility = View.VISIBLE
        judgmentRow.visibility = View.GONE
        outputA.text = ""
        outputB.text = ""
        scoreA.text = ""
        scoreB.text = ""
        statusText.text = "Generating both columns…"

        lifecycleScope.launch {
            val (baseOut, loraOut) = withContext(Dispatchers.IO) { generateBoth(prompt, mm) }
            currentBase = baseOut
            currentLora = loraOut

            // Cosine scores against the user centroid, if we have one.
            val baseScore = baseOut?.let { withContext(Dispatchers.IO) { VoiceMetric.score(this@VoiceCompareActivity, it) } }
            val loraScore = loraOut?.let { withContext(Dispatchers.IO) { VoiceMetric.score(this@VoiceCompareActivity, it) } }
            currentBaseScore = baseScore
            currentLoraScore = loraScore

            renderResults(baseOut, loraOut, baseScore, loraScore)
            generateButton.isEnabled = true
            spinner.visibility = View.GONE
        }
    }

    /**
     * Generate the same prompt through base + LoRA. We use [LocalLlm.dropLora]
     * / [LocalLlm.swapLora] for the runtime swap — both calls share the same
     * loaded model in memory (the llama.cpp KV cache is cleared on each
     * adapter change, so old state doesn't bleed across).
     */
    private suspend fun generateBoth(prompt: String, mm: ModelManager): Pair<String?, String?> {
        val llm = LocalLlm.get(this) ?: return null to null
        val qwenPrompt = buildString {
            append("<|im_start|>system\n")
            append("Draft a short email body fulfilling the user's intent. ")
            append("4 sentences max. Direct, plain voice. No filler.")
            append("<|im_end|>\n")
            append("<|im_start|>user\n").append(prompt).append("<|im_end|>\n")
            append("<|im_start|>assistant\n")
        }

        llm.dropLora()
        val baseOut = llm.generateOnce(qwenPrompt)
            ?.substringBefore("<|im_end|>")?.trim()

        if (mm.isLoraReady()) {
            llm.swapLora(mm.getLoraPath(), 1.0f)
        } // else: leave base loaded; LoRA column will mirror base output below.
        val loraOut = llm.generateOnce(qwenPrompt)
            ?.substringBefore("<|im_end|>")?.trim()

        // Restore the runtime to whatever the user's `voiceLoraActive` flag
        // says it should be when they leave this screen.
        if (!storage.voiceLoraActive()) llm.dropLora()

        return baseOut to loraOut
    }

    private fun renderResults(baseOut: String?, loraOut: String?, baseScore: Float?, loraScore: Float?) {
        if (baseOut.isNullOrBlank() || loraOut.isNullOrBlank()) {
            statusText.text = "Generation failed — try a shorter prompt"
            return
        }
        val (textA, textB) = if (baseOnLeft) baseOut to loraOut else loraOut to baseOut
        outputA.text = textA
        outputB.text = textB
        scoreA.text = formatScore(if (baseOnLeft) baseScore else loraScore)
        scoreB.text = formatScore(if (baseOnLeft) loraScore else baseScore)
        judgmentRow.visibility = View.VISIBLE
        statusText.text = "Pick the one that sounds more like you."
    }

    private fun formatScore(score: Float?): String =
        if (score == null) "" else "Voice-match: %.2f".format(score)

    private fun onPick(chosen: String) {
        val prompt = currentPrompt ?: return
        val baseOut = currentBase ?: return
        val loraOut = currentLora ?: return
        lifecycleScope.launch {
            withContext(Dispatchers.IO) {
                GholaMailDatabase.get(this@VoiceCompareActivity)
                    .voicePreferenceDao()
                    .insert(
                        VoicePreference(
                            prompt = prompt,
                            baseOutput = baseOut,
                            loraOutput = loraOut,
                            chosen = chosen,
                            baseOnLeft = baseOnLeft,
                            createdAt = System.currentTimeMillis(),
                            baseScore = currentBaseScore,
                            loraScore = currentLoraScore,
                        )
                    )
            }
            // Reveal which column was which — pitch payoff moment.
            val reveal = if (baseOnLeft) "A = base   ·   B = LoRA" else "A = LoRA   ·   B = base"
            labelA.text = if (baseOnLeft) "› A · base" else "› A · LoRA"
            labelB.text = if (baseOnLeft) "› B · LoRA" else "› B · base"
            statusText.text = "Logged \"$chosen\". $reveal"
            judgmentRow.visibility = View.GONE
        }
    }
}
