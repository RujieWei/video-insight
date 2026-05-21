import type { LearningOverview, SubtitleSegment } from "../types/learning";

export const mockOverview: LearningOverview = {
  summary:
    "这支视频围绕 Claude Code 的高效使用展开，重点讨论环境配置、权限管理、上下文文件和工具联动等实践。它适合作为第一次搭建 AI 编程工作流时的操作参考。",
  chapters: [
    {
      title: "环境与配置基础",
      startTime: 0,
      endTime: 420,
      summary: "介绍 Claude Code 的基础环境、配置文件和项目上下文管理方式。",
      keyPoints: ["用项目文档稳定上下文", "把配置和权限作为开发前置工作", "减少重复解释需求的成本"]
    },
    {
      title: "权限管理与工具协作",
      startTime: 420,
      endTime: 930,
      summary: "说明如何通过权限设置和工具调用，让 AI 编程过程更可控。",
      keyPoints: ["避免一次性放开高风险权限", "让 AI 先读错误再修复", "每次只推进一个功能切片"]
    },
    {
      title: "现场问题与实践建议",
      startTime: 930,
      endTime: 1550,
      summary: "结合现场问答讨论常见问题，并给出适合非工程背景用户的实践节奏。",
      keyPoints: ["先做可见结果再接复杂能力", "保持文档同步", "用小步验收建立信心"]
    }
  ],
  mindmapMermaid: `mindmap
  root((Claude Code 实践))
    环境配置
      CLAUDE.md
      项目规则
    权限管理
      工具调用
      安全边界
    Vibe Coding
      小步推进
      可见验收
      文档同步`
};

export const mockSubtitleSegments: SubtitleSegment[] = [
  {
    startTime: 12,
    endTime: 18,
    englishText: "Claude Code works best when the project context is explicit and easy to reload.",
    chineseText: "当项目上下文清晰、并且容易重新加载时，Claude Code 的效果最好。"
  },
  {
    startTime: 19,
    endTime: 27,
    englishText: "Instead of asking the model to guess, write down the rules that should guide every change.",
    chineseText: "不要让模型猜，而是把每次改动都应该遵守的规则写下来。"
  },
  {
    startTime: 31,
    endTime: 39,
    englishText: "Permission management is not just a security concern; it also shapes the rhythm of development.",
    chineseText: "权限管理不只是安全问题，它也会影响开发推进的节奏。"
  },
  {
    startTime: 44,
    endTime: 52,
    englishText: "For beginners, the most useful workflow is one visible step at a time.",
    chineseText: "对初学者来说，最有用的工作流是一次只推进一个可见步骤。"
  },
  {
    startTime: 57,
    endTime: 66,
    englishText: "When a feature is small enough to verify manually, it is also easier to repair when something breaks.",
    chineseText: "当一个功能小到可以手动验证时，出问题后也更容易修复。"
  }
];
