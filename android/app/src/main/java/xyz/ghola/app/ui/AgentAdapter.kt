package xyz.ghola.app.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONObject
import xyz.ghola.app.R

/**
 * RecyclerView adapter for the agents list. Each item is a JSONObject with at
 * least `id`, `slug`, `display_name`, `did`, `status` fields (the response
 * shape from said-cloud's GET /v1/agents endpoint).
 */
class AgentAdapter(
    private var agents: List<JSONObject>,
    private val onClick: (JSONObject) -> Unit
) : RecyclerView.Adapter<AgentAdapter.AgentViewHolder>() {

    fun setAgents(newAgents: List<JSONObject>) {
        agents = newAgents
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): AgentViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_agent_card, parent, false)
        return AgentViewHolder(view)
    }

    override fun onBindViewHolder(holder: AgentViewHolder, position: Int) {
        holder.bind(agents[position])
    }

    override fun getItemCount(): Int = agents.size

    inner class AgentViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val displayName: TextView = itemView.findViewById(R.id.cardDisplayName)
        private val slug: TextView = itemView.findViewById(R.id.cardSlug)
        private val bio: TextView = itemView.findViewById(R.id.cardBio)
        private val did: TextView = itemView.findViewById(R.id.cardDid)
        private val status: TextView = itemView.findViewById(R.id.cardStatus)

        fun bind(agent: JSONObject) {
            displayName.text = agent.optString("display_name", "Untitled")
            slug.text = "@${agent.optString("slug", "")}"
            val bioText = agent.optString("bio", "")
            if (bioText.isNotEmpty() && bioText != "null") {
                bio.text = bioText
                bio.visibility = View.VISIBLE
            } else {
                bio.visibility = View.GONE
            }
            did.text = truncateDid(agent.optString("did", ""))
            status.text = agent.optString("status", "active")
            itemView.setOnClickListener { onClick(agent) }
        }

        private fun truncateDid(did: String): String {
            if (did.length <= 24) return did
            return "${did.take(16)}…${did.takeLast(6)}"
        }
    }
}
