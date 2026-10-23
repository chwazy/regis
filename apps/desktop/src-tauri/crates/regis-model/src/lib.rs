#![allow(dead_code, unused_imports)]

mod agent;
mod approval;
mod brain;
mod brief;
mod connector;
mod dashboard;
mod entity;
mod fact;
mod file;
mod item;
mod job;
mod link;
mod policy;
mod recording;
mod routing;
mod search;
mod template;

pub use agent::{Agent, AgentMode, AgentRuntime};
pub use approval::{Approval, ApprovalStatus, NewApproval};
pub use brain::{
    ChunkNeighbor, ChunkText, DocumentHit, EntityCard, EntityNote, EntityStats, EntitySummary,
    EntitySynthesis, FactDecision, FactSource, FactView, GlobalSearchResult, LinkProposalRow,
    LinkedDocument, LinkedEntity, MailHit, NoteHit, ProjectSummary, TimelineEntry,
};
pub use brief::Brief;
pub use connector::Connector;
pub use dashboard::{Dashboard, Widget};
pub use entity::{Entity, EntityKind};
pub use fact::{Fact, FactStatus};
pub use file::{FileEntry, FileSource};
pub use item::{Item, ItemKind, ItemUpsert};
pub use job::{Job, JobEvent, JobEventType, JobStatus, NewJob, NewJobEvent};
pub use link::Link;
pub use policy::{Policy, ToolPolicy};
pub use recording::{
    Recording, RecordingSources, RecordingStatus, RecordingView, SegmentSource,
    StartRecordingInput, TranscriptSegment,
};
pub use routing::RoutingRule;
pub use search::SearchHit;
pub use template::Template;
