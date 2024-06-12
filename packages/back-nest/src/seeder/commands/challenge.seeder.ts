import { ConfigService } from '@nestjs/config';
import { Octokit as OctokitInstance } from '@octokit/core';
import { Command, CommandRunner } from 'nest-commander';
import { Octokit } from 'octokit';
import { ChallengeService } from 'src/challenges/services/challenge.service';
import { ProjectService } from 'src/projects/services/project.service';
import { minimatch } from 'minimatch';
import { Challenge } from 'src/challenges/entities/challenge.entity';
import pRetry from 'p-retry';
import * as stripComments from 'strip-comments';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Command({
  name: 'seed-challenges',
  arguments: '',
  options: {},
})
export class ProjectSeedRunner extends CommandRunner {
  private projectScanningList: {
    repository: string;
    patterns: string[];
    maxLOC?: number;
  }[] = [
    {
      repository: 'nocobase/nocobase',
      patterns: ['*.ts', '*.tsx', '!*.spec.ts', '!*.test.ts', '!*.spec.js'],
      maxLOC: 30,
    },
  ];

  private treeDepth = 300;

  constructor(
    private projectService: ProjectService,
    private challengeService: ChallengeService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async run(): Promise<void> {
    const octokit: OctokitInstance = new Octokit({
      auth: this.configService.get('GITHUB_ACCESS_TOKEN'),
    });

    for (const projectScanning of this.projectScanningList) {
      const [owner, repo] = projectScanning.repository.split('/');

      const upsertProject = async () => {
        const metadata = await octokit.request('GET /repos/{owner}/{repo}', {
          owner,
          repo,
        });

        const existentProject = await this.projectService.repo.findOne({
          where: {
            fullName: projectScanning.repository,
          },
        });

        if (existentProject) {
          console.log(
            `Project ${projectScanning.repository} already exists. Early exit`,
          );

          return {
            project: existentProject,
            metadata,
          };
        }

        const project = await this.projectService.repo.save(
          this.projectService.repo.create({
            language: this.challengeService.completeLanguageToName(
              metadata.data.language,
            ),
            fullName: projectScanning.repository,
            htmlUrl: metadata.data.html_url,
            stars: metadata.data.stargazers_count,
            licenseName: metadata.data.license?.name ?? 'Other',
            ownerAvatar: metadata.data.owner.avatar_url,
            defaultBranch: metadata.data.default_branch,
            syncedSha: metadata.data.default_branch,
          }),
        );

        console.log(
          `Project ${projectScanning.repository} created. Project ID: ${project.id}`,
        );

        return {
          project,
          metadata,
        };
      };

      const { project, metadata } = await upsertProject();

      let treeIteration = 0;

      const iterateTree = async (treeSha: string) => {
        if (treeIteration > this.treeDepth) {
          console.log('treeIteration > this.treeDepth');
          return;
        }

        treeIteration++;

        const tree = await octokit.request(
          'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
          {
            owner,
            repo,
            tree_sha: treeSha,
          },
        );

        for (const file of tree.data.tree) {
          if (file.type === 'tree' && file.sha) {
            await iterateTree(file.sha);
            continue;
          }

          console.log('file', JSON.stringify(file, null, 4));

          const negatePatterns = projectScanning.patterns.filter((pattern) =>
            pattern.startsWith('!'),
          );

          const affirmativePatterns = projectScanning.patterns.filter(
            (pattern) => !pattern.startsWith('!'),
          );

          const affirmativePatternPass = affirmativePatterns.some((pattern) =>
            minimatch(file.path, pattern),
          );

          const negatePatternPass = negatePatterns.every((negatePattern) =>
            minimatch(file.path, negatePattern),
          );

          const matchedPattern = affirmativePatternPass && !!negatePatternPass;

          if (matchedPattern) {
            console.log(
              `File ${file.path} matches the pattern ${matchedPattern}`,
            );

            const fetchFileContents = async () => {
              const response = await fetch(file.url, {
                headers: {
                  Authorization: `Bearer ${this.configService.get(
                    'GITHUB_ACCESS_TOKEN',
                  )}`,
                },
              }).then(async (res) => await res.json());

              if (!response.content) {
                throw new Error('No content found. Rate limit exceeded');
              }

              return Buffer.from(response.content, 'base64').toString('utf-8');
            };

            const contentsWithPotentialComments = await pRetry(
              fetchFileContents,
              {
                //@ts-ignore
                retries: 60,
                onFailedAttempt: async () => {
                  console.log(
                    `Received a 429 error for file ${file.path}. Retrying in 1 second`,
                  );
                  await sleep(1000);
                },
              },
            );

            const contents = stripComments(contentsWithPotentialComments, {
              preserveNewlines: false,
            });

            const linesCount = contents.split('\n').length;

            if (projectScanning.maxLOC && linesCount > projectScanning.maxLOC) {
              console.log(
                `File ${file.path} exceeds the max LOC of ${projectScanning.maxLOC}`,
              );

              continue;
            }

            const upsertChallenge = async () => {
              const existentChallenge =
                await this.challengeService.repo.findOne({
                  where: {
                    path: file.path,
                    projectId: project.id,
                  },
                });

              if (existentChallenge) {
                console.log(
                  `Challenge ${file.path} already exists. Early return`,
                );
                return existentChallenge;
              }

              const challenge = (await this.challengeService.repo.save(
                //@ts-ignore
                this.challengeService.repo.create({
                  loc: linesCount,
                  path: file.path,
                  language: this.challengeService.completeLanguageToName(
                    metadata.data.language!,
                  ),
                  url: metadata.data.html_url + file.path,
                  content: contents,
                  project,
                  sha: file.sha,
                  treeSha: treeSha,
                }),
              )) as any as Challenge;

              console.log(
                `Challenge ${file.path} created. Challenge ID: ${challenge.id}`,
              );

              return challenge;
            };

            const challenge = await upsertChallenge();

            console.log(
              `Challenge ${file.path} created. Challenge ID: ${challenge.id}`,
            );

            continue;
          }

          if (!matchedPattern) {
            console.log(`File ${file.path} does not match the pattern`);
          }
        }
      };

      await iterateTree(metadata.data.default_branch);
    }
  }
}
