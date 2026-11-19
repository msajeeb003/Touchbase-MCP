import { NextFunction, Request, Response } from "express";
import { AnyZodObject } from "zod";

/**
 * Validates the request and then REPLACES req.body with the validated result.
 *
 * The schemas list the fields a route accepts. Before this, the check ran but
 * the original body was passed on, so a field that is not in the schema
 * (for example "userId") could still reach the database.
 *
 * Express 5 does not allow req.query to be replaced, so the validated query
 * and params are put on res.locals.validated for routes that want them.
 */
const validateRequest = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      if (parsed.body !== undefined) {
        req.body = parsed.body;
      }

      res.locals.validated = { query: parsed.query, params: parsed.params };

      next();
    } catch (error) {
      next(error);
    }
  };
};

export default validateRequest;
